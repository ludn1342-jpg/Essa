const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CapMonster config
const CAPMONSTER_KEY = process.env.CAPMONSTER_KEY || 'eceb21c3a772cce204e2b666e7ebe25d';

// ============================================
// Resolver CAPTCHA con CapMonster
// ============================================
async function solveRecaptcha(siteKey, pageUrl) {
  console.log('[CAPTCHA] Enviando a CapMonster...');
  const createRes = await fetch('https://api.capmonster.cloud/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPMONSTER_KEY,
      task: {
        type: 'RecaptchaV2TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
      },
    }),
  });
  const createData = await createRes.json();

  if (createData.errorId !== 0) {
    throw new Error(`CapMonster error: ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`[CAPTCHA] Task creada: ${taskId}`);

  // Polling cada 3s, máx 120s
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const resultRes = await fetch('https://api.capmonster.cloud/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPMONSTER_KEY, taskId }),
    });
    const resultData = await resultRes.json();

    if (resultData.status === 'ready') {
      console.log('[CAPTCHA] Resuelto OK');
      return resultData.solution.gRecaptchaResponse;
    }
    if (resultData.errorId !== 0) {
      throw new Error(`CapMonster polling error: ${resultData.errorDescription}`);
    }
  }
  throw new Error('CapMonster timeout - 120s');
}

// ============================================
// Resolver HCaptcha con CapMonster
// ============================================
async function solveHCaptcha(siteKey, pageUrl) {
  console.log('[HCAPTCHA] Enviando a CapMonster...');
  const createRes = await fetch('https://api.capmonster.cloud/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPMONSTER_KEY,
      task: {
        type: 'HCaptchaTaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
      },
    }),
  });
  const createData = await createRes.json();

  if (createData.errorId !== 0) {
    throw new Error(`CapMonster HCaptcha error: ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`[HCAPTCHA] Task creada: ${taskId}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const resultRes = await fetch('https://api.capmonster.cloud/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPMONSTER_KEY, taskId }),
    });
    const resultData = await resultRes.json();

    if (resultData.status === 'ready') {
      console.log('[HCAPTCHA] Resuelto OK');
      return resultData.solution.gRecaptchaResponse;
    }
    if (resultData.errorId !== 0) {
      throw new Error(`CapMonster HCaptcha polling error: ${resultData.errorDescription}`);
    }
  }
  throw new Error('CapMonster HCaptcha timeout');
}

// ============================================
// Consultar ESSA vía HTTP directo
// ============================================
async function consultarESSA(cuentas, tipoPago) {
  const PAGE_URL = 'https://sites.placetopay.com/essa/session';

  const tipoPagoMap = {
    total: 'total',
    sin_alumbrado: 'without_public_lighting',
    abonos: 'payment',
    saldos: 'balance',
  };

  // === PASO 1: GET la página para cookies + CSRF + captcha ===
  console.log('[1] GET página inicial...');
  const sessionRes = await fetch(PAGE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
    },
  });

  console.log(`[1] Status: ${sessionRes.status}`);

  // Cookies
  let cookies = '';
  const setCookieHeader = sessionRes.headers.get('set-cookie');
  if (setCookieHeader) {
    cookies = setCookieHeader.split(',').map(c => c.split(';')[0].trim()).join('; ');
  }
  if (sessionRes.headers.getSetCookie) {
    const cookieArr = sessionRes.headers.getSetCookie();
    if (cookieArr.length > 0) {
      cookies = cookieArr.map(c => c.split(';')[0].trim()).join('; ');
    }
  }
  console.log(`[1] Cookies: ${cookies.substring(0, 100)}...`);

  const html = await sessionRes.text();
  console.log(`[1] HTML length: ${html.length}`);

  // CSRF token
  const csrfMatch = html.match(/name="_token"\s*(?:type="hidden"\s*)?value="([^"]+)"/i)
    || html.match(/value="([^"]+)"\s*name="_token"/i)
    || html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i)
    || html.match(/_token['"]\s*:\s*['"]([\w]+)['"]/);
  const csrf = csrfMatch ? csrfMatch[1] : '';
  console.log(`[1] CSRF: ${csrf ? csrf.substring(0, 20) + '...' : 'NO ENCONTRADO'}`);

  // Detectar tipo de CAPTCHA
  // hCaptcha
  const hcaptchaMatch = html.match(/data-sitekey="([^"]+)"[\s\S]*?hcaptcha/i)
    || html.match(/hcaptcha[\s\S]*?data-sitekey="([^"]+)"/i)
    || html.match(/class="h-captcha"[\s\S]*?data-sitekey="([^"]+)"/i);

  // reCAPTCHA
  const recaptchaMatch = html.match(/data-sitekey="([^"]+)"[\s\S]*?recaptcha/i)
    || html.match(/recaptcha[\s\S]*?data-sitekey="([^"]+)"/i)
    || html.match(/class="g-recaptcha"[\s\S]*?data-sitekey="([^"]+)"/i)
    || html.match(/sitekey['":\s]+['"]([0-9a-zA-Z_-]{20,})['"]/i);

  let captchaToken = '';

  if (hcaptchaMatch) {
    console.log(`[1] HCaptcha detectado: ${hcaptchaMatch[1]}`);
    captchaToken = await solveHCaptcha(hcaptchaMatch[1], PAGE_URL);
  } else if (recaptchaMatch) {
    console.log(`[1] reCAPTCHA detectado: ${recaptchaMatch[1]}`);
    captchaToken = await solveRecaptcha(recaptchaMatch[1], PAGE_URL);
  } else {
    console.log('[1] NO se detectó CAPTCHA');
    // Buscar cualquier sitekey
    const anySitekey = html.match(/data-sitekey="([^"]+)"/i);
    if (anySitekey) {
      console.log(`[1] Sitekey encontrado genérico: ${anySitekey[1]}`);
      // Intentar como reCAPTCHA primero
      try {
        captchaToken = await solveRecaptcha(anySitekey[1], PAGE_URL);
      } catch (e) {
        console.log('[1] Falló reCAPTCHA, intentando HCaptcha...');
        captchaToken = await solveHCaptcha(anySitekey[1], PAGE_URL);
      }
    }
  }

  // Detectar nombres de campos del form
  console.log('[DEBUG] Buscando campos del formulario...');
  const formFields = html.match(/<input[^>]*name="([^"]+)"[^>]*>/gi) || [];
  const selectFields = html.match(/<select[^>]*name="([^"]+)"[^>]*>/gi) || [];
  console.log('[DEBUG] Inputs:', formFields.map(f => f.match(/name="([^"]+)"/)?.[1]).filter(Boolean).join(', '));
  console.log('[DEBUG] Selects:', selectFields.map(f => f.match(/name="([^"]+)"/)?.[1]).filter(Boolean).join(', '));

  // Detectar action del form
  const formAction = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
  const postUrl = formAction ? new URL(formAction[1], PAGE_URL).href : PAGE_URL;
  console.log(`[DEBUG] Form action URL: ${postUrl}`);

  // Detectar method
  const formMethod = html.match(/<form[^>]*method="([^"]+)"[^>]*>/i);
  console.log(`[DEBUG] Form method: ${formMethod ? formMethod[1] : 'default'}`);

  // === PASO 2: POST el formulario ===
  console.log('[2] POST formulario...');
  const formData = new URLSearchParams();
  if (csrf) formData.append('_token', csrf);

  // Campos del formulario - intentar variantes comunes de PlaceToPay micrositios
  formData.append('type', 'account');
  formData.append('payment_type', tipoPagoMap[tipoPago] || 'total');

  // Enviar cuentas como references[]
  cuentas.forEach((c) => {
    formData.append('references[]', c);
  });

  // CAPTCHA tokens
  if (captchaToken) {
    formData.append('g-recaptcha-response', captchaToken);
    formData.append('h-captcha-response', captchaToken);
  }

  console.log(`[2] Form data: ${formData.toString().substring(0, 200)}...`);

  const consultaRes = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Referer': PAGE_URL,
      'Origin': 'https://sites.placetopay.com',
      'Cookie': cookies,
    },
    body: formData.toString(),
    redirect: 'manual',
  });

  const resStatus = consultaRes.status;
  const location = consultaRes.headers.get('location');
  console.log(`[2] Response status: ${resStatus}`);
  console.log(`[2] Location: ${location || 'ninguno'}`);

  let resBody = await consultaRes.text();
  console.log(`[2] Response body length: ${resBody.length}`);
  console.log(`[2] Response preview: ${resBody.substring(0, 500)}`);

  // Si hay redirect, seguirlo
  if (location && (resStatus === 301 || resStatus === 302 || resStatus === 303)) {
    const fullLocation = new URL(location, 'https://sites.placetopay.com').href;
    console.log(`[3] Siguiendo redirect a: ${fullLocation}`);

    const redirectRes = await fetch(fullLocation, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': PAGE_URL,
        'Cookie': cookies,
      },
    });

    resBody = await redirectRes.text();
    console.log(`[3] Redirect response length: ${resBody.length}`);
    console.log(`[3] Redirect preview: ${resBody.substring(0, 500)}`);
  }

  // === PASO 3: Parsear resultado ===
  return parseResponse(resBody);
}

// ============================================
// Parser inteligente de respuesta
// ============================================
function parseResponse(html) {
  // 1. ¿Es JSON directo?
  try {
    const json = JSON.parse(html);
    if (json.data || json.facturas || json.invoices) {
      return { success: true, facturas: json.data || json.facturas || json.invoices };
    }
    return { success: true, facturas: [json] };
  } catch (e) {
    // No es JSON, continuar
  }

  // 2. Buscar JSON embebido en el HTML
  const jsonPatterns = [
    /var\s+(?:data|invoices|facturas|bills|results)\s*=\s*(\[[\s\S]*?\]);/,
    /JSON\.parse\s*\(\s*'(\[[\s\S]*?\])'\s*\)/,
    /"invoices"\s*:\s*(\[[\s\S]*?\])/,
    /"data"\s*:\s*(\[[\s\S]*?\])/,
  ];

  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return { success: true, facturas: JSON.parse(match[1]) };
      } catch (e) { /* continuar */ }
    }
  }

  // 3. Buscar tablas HTML con datos
  const facturas = [];

  // Buscar headers de tabla primero
  const headerMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  let headers = [];
  if (headerMatch) {
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRegex.exec(headerMatch[1])) !== null) {
      headers.push(thMatch[1].replace(/<[^>]+>/g, '').trim());
    }
  }

  // Buscar filas de datos
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const searchHtml = tbodyMatch ? tbodyMatch[1] : html;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(searchHtml)) !== null) {
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 2) {
      if (headers.length === cells.length) {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i]; });
        facturas.push(obj);
      } else {
        facturas.push(cells);
      }
    }
  }

  if (facturas.length > 0) {
    return { success: true, facturas };
  }

  // 4. Buscar divs/spans con datos de factura
  const dataPatterns = [
    { label: 'Referencia', regex: /referencia[:\s]*#?\s*([0-9]+)/gi },
    { label: 'Total', regex: /total[:\s]*\$?\s*([\d.,]+)/gi },
    { label: 'Fecha', regex: /fecha[:\s]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/gi },
    { label: 'Cuenta', regex: /cuenta[:\s]*([0-9]+)/gi },
    { label: 'Estado', regex: /estado[:\s]*([\w\sáéíóú]+)/gi },
    { label: 'Vencimiento', regex: /vencimiento[:\s]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/gi },
  ];

  const extracted = {};
  for (const p of dataPatterns) {
    const m = html.match(p.regex);
    if (m) extracted[p.label] = m.map(v => v.replace(/^[^:]*:\s*/, '').trim());
  }

  if (Object.keys(extracted).length >= 2) {
    return { success: true, facturas: [extracted] };
  }

  // 5. Buscar mensajes de error del sitio
  const errorPatterns = [
    /class="alert[^"]*alert-(?:danger|warning)"[^>]*>([\s\S]*?)<\/div>/i,
    /class="error[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /class="message[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /class="notification[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of errorPatterns) {
    const match = html.match(pattern);
    if (match) {
      const msg = match[1].replace(/<[^>]+>/g, '').trim();
      if (msg.length > 5) {
        return {
          success: false,
          message: `Respuesta del sitio: ${msg}`,
          preview: html.substring(0, 2000),
        };
      }
    }
  }

  // 6. No se pudo parsear - devolver debug
  // Extraer solo el texto visible del body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const visibleText = (bodyMatch ? bodyMatch[1] : html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 1500);

  return {
    success: false,
    message: 'No se pudo extraer datos de factura',
    visibleText: visibleText || '(página vacía)',
    htmlLength: html.length,
    preview: html.substring(0, 2000),
  };
}

// ============================================
// ENDPOINTS
// ============================================

// Consultar factura
app.post('/api/consultar', async (req, res) => {
  try {
    const { cuentas, tipoPago } = req.body;

    if (!cuentas || !Array.isArray(cuentas) || cuentas.length === 0) {
      return res.status(400).json({ error: 'Se requiere al menos un número de cuenta' });
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Consultando cuentas: ${cuentas.join(', ')} | Tipo: ${tipoPago}`);
    console.log(`${'='.repeat(50)}`);

    const resultado = await consultarESSA(cuentas, tipoPago || 'total');
    res.json(resultado);
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      error: error.message,
      success: false,
    });
  }
});

// Debug endpoint - ver qué devuelve la página
app.get('/api/debug', async (req, res) => {
  try {
    const pageRes = await fetch('https://sites.placetopay.com/essa/session', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });

    const html = await pageRes.text();

    // Extraer info útil
    const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
    const inputs = html.match(/<input[^>]+>/gi) || [];
    const selects = html.match(/<select[^>]*name="([^"]+)"[\s\S]*?<\/select>/gi) || [];
    const captcha = html.match(/sitekey|captcha|hcaptcha|recaptcha/gi) || [];
    const title = html.match(/<title>([\s\S]*?)<\/title>/i);

    res.json({
      status: pageRes.status,
      htmlLength: html.length,
      title: title ? title[1].trim() : 'N/A',
      formsCount: forms.length,
      inputs: inputs.map(i => {
        const name = i.match(/name="([^"]+)"/)?.[1];
        const type = i.match(/type="([^"]+)"/)?.[1];
        const value = i.match(/value="([^"]+)"/)?.[1];
        return { name, type, value: value?.substring(0, 30) };
      }),
      selectNames: selects.map(s => s.match(/name="([^"]+)"/)?.[1]),
      captchaKeywords: captcha,
      htmlPreview: html.substring(0, 3000),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    capmonster: CAPMONSTER_KEY ? 'configurado' : 'no configurado',
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ESSA API Server corriendo en http://localhost:${PORT}`);
  console.log(`CapMonster Key: ${CAPMONSTER_KEY.substring(0, 8)}...`);
});
