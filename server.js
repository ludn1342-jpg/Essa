const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURACIÓN PlaceToPay API - ESSA
// ============================================
const P2P_CONFIG = {
  // URL base de PlaceToPay (producción Colombia)
  baseUrl: 'https://checkout.placetopay.com',
  // Credenciales del micrositio ESSA
  // NOTA: Estas son las credenciales del comercio ESSA.
  // Si no las tienes, necesitas solicitarlas a ESSA o PlaceToPay.
  login: process.env.P2P_LOGIN || 'TU_LOGIN_AQUI',
  secretKey: process.env.P2P_SECRET || 'TU_SECRET_KEY_AQUI',
};

// CapMonster config (por si la consulta requiere captcha)
const CAPMONSTER_KEY = process.env.CAPMONSTER_KEY || 'eceb21c3a772cce204e2b666e7ebe25d';

// ============================================
// Generador de autenticación WSSE PlaceToPay
// ============================================
function generateAuth() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const seed = new Date().toISOString();
  const nonceBase64 = Buffer.from(nonce).toString('base64');

  // tranKey = Base64(SHA256(nonce + seed + secretKey))
  const rawTranKey = nonce + seed + P2P_CONFIG.secretKey;
  const tranKey = crypto
    .createHash('sha256')
    .update(rawTranKey)
    .digest('base64');

  return {
    login: P2P_CONFIG.login,
    tranKey,
    nonce: nonceBase64,
    seed,
  };
}

// ============================================
// Resolver CAPTCHA con CapMonster (si es necesario)
// ============================================
async function solveRecaptcha(siteKey, pageUrl) {
  // Crear tarea
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

  // Esperar resultado (polling cada 3s, máx 120s)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const resultRes = await fetch('https://api.capmonster.cloud/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPMONSTER_KEY, taskId }),
    });
    const resultData = await resultRes.json();

    if (resultData.status === 'ready') {
      return resultData.solution.gRecaptchaResponse;
    }
  }
  throw new Error('CapMonster timeout');
}

// ============================================
// MÉTODO 1: API PlaceToPay (si tienes credenciales)
// ============================================
async function consultarPlaceToPay(cuentas, tipoPago) {
  const auth = generateAuth();

  // Crear sesión de consulta/pago
  const response = await fetch(`${P2P_CONFIG.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locale: 'es_CO',
      auth,
      payment: {
        reference: cuentas[0],
        description: `Consulta factura ESSA - ${tipoPago}`,
        amount: { currency: 'COP', total: 0 },
      },
      expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      returnUrl: 'https://localhost:3000/retorno',
      ipAddress: '127.0.0.1',
      userAgent: 'ESSA-API-Server/1.0',
    }),
  });

  return await response.json();
}

// ============================================
// MÉTODO 2: Scraping directo HTTP (sin navegador)
// ============================================
async function consultarESSADirecto(cuentas, tipoPago) {
  const tipoPagoMap = {
    total: '1',
    sin_alumbrado: '2',
    abonos: '3',
    saldos: '4',
  };

  // Paso 1: Obtener la página y cookies/tokens
  const sessionRes = await fetch('https://sites.placetopay.com/essa/session', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-CO,es;q=0.9',
    },
  });

  const cookies = sessionRes.headers
    .getSetCookie?.()
    ?.join('; ') || sessionRes.headers.get('set-cookie') || '';

  const html = await sessionRes.text();

  // Extraer token CSRF si existe
  const csrfMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : '';

  // Extraer sitekey de reCAPTCHA/hCaptcha si existe
  const recaptchaMatch = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
  const siteKey = recaptchaMatch ? recaptchaMatch[1] : null;

  let captchaToken = '';
  if (siteKey) {
    console.log(`CAPTCHA detectado (siteKey: ${siteKey}), resolviendo con CapMonster...`);
    captchaToken = await solveRecaptcha(siteKey, 'https://sites.placetopay.com/essa/session');
    console.log('CAPTCHA resuelto.');
  }

  // Paso 2: Enviar consulta de factura
  const formData = new URLSearchParams();
  if (csrf) formData.append('_token', csrf);
  formData.append('type', 'account'); // tipo consulta: número de cuenta
  formData.append('payment_type', tipoPagoMap[tipoPago] || '1');
  cuentas.forEach((c) => formData.append('references[]', c));
  if (captchaToken) {
    formData.append('g-recaptcha-response', captchaToken);
    formData.append('h-captcha-response', captchaToken);
  }

  const consultaRes = await fetch('https://sites.placetopay.com/essa/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://sites.placetopay.com/essa/session',
      Cookie: cookies,
    },
    body: formData.toString(),
    redirect: 'manual', // no seguir redirects automáticamente
  });

  const resBody = await consultaRes.text();
  const status = consultaRes.status;
  const location = consultaRes.headers.get('location');

  // Si redirige, seguir la redirección para obtener datos de factura
  if (location) {
    const facturaRes = await fetch(location, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Cookie: cookies,
      },
    });
    const facturaHtml = await facturaRes.text();
    return parseFacturaHTML(facturaHtml);
  }

  return parseFacturaHTML(resBody);
}

// ============================================
// Parser de HTML de factura
// ============================================
function parseFacturaHTML(html) {
  const facturas = [];

  // Buscar datos de factura en el HTML
  // Patrones comunes en la respuesta de PlaceToPay/ESSA
  const referenceMatch = html.match(/referencia[:\s]*([0-9]+)/gi);
  const totalMatch = html.match(/total[:\s]*\$?\s*([\d.,]+)/gi);
  const fechaMatch = html.match(/fecha[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi);
  const cuentaMatch = html.match(/cuenta[:\s]*([0-9]+)/gi);

  // Intentar extraer JSON embebido si existe
  const jsonMatch = html.match(/var\s+(?:data|invoices|facturas|bills)\s*=\s*(\[[\s\S]*?\]);/);
  if (jsonMatch) {
    try {
      return { success: true, facturas: JSON.parse(jsonMatch[1]) };
    } catch (e) {
      // continuar con parsing HTML
    }
  }

  // Buscar tablas con datos de factura
  const rowRegex =
    /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 2) {
      facturas.push(cells);
    }
  }

  if (facturas.length > 0) {
    return { success: true, facturas, raw: false };
  }

  // Si no se pudo parsear, devolver HTML crudo para debug
  return {
    success: false,
    message: 'No se pudo extraer datos estructurados',
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

    console.log(`Consultando cuentas: ${cuentas.join(', ')} | Tipo: ${tipoPago}`);

    // Intentar método directo HTTP
    const resultado = await consultarESSADirecto(cuentas, tipoPago || 'total');

    res.json(resultado);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Verifica la conexión o intenta con credenciales PlaceToPay',
    });
  }
});

// Consultar vía PlaceToPay API (requiere credenciales)
app.post('/api/consultar-p2p', async (req, res) => {
  try {
    const { cuentas, tipoPago } = req.body;

    if (P2P_CONFIG.login === 'TU_LOGIN_AQUI') {
      return res.status(400).json({
        error: 'Credenciales PlaceToPay no configuradas',
        hint: 'Configura P2P_LOGIN y P2P_SECRET en las variables de entorno',
      });
    }

    const resultado = await consultarPlaceToPay(cuentas, tipoPago);
    res.json(resultado);
  } catch (error) {
    console.error('Error P2P:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ESSA API Server corriendo en http://localhost:${PORT}`);
  console.log(`CapMonster Key: ${CAPMONSTER_KEY.substring(0, 8)}...`);
  console.log(`PlaceToPay: ${P2P_CONFIG.login === 'TU_LOGIN_AQUI' ? 'Sin credenciales (modo scraping)' : 'Configurado'}`);
});
