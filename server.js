const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CAPMONSTER_KEY = 'eceb21c3a772cce204e2b666e7ebe25d';
const ESSA_BASE = 'https://sites.placetopay.com';
const LOGIN_URL = `${ESSA_BASE}/essa/login`;
const RECAPTCHA_SITEKEY = '6Lc1WxkUAAAAAANhMFQXXYWC6Bb7HrqGUehlCtAN';

// =====================================================================
//  CapMonster - Resolver reCAPTCHA v2
// =====================================================================
async function solveCaptcha(siteKey, pageUrl) {
    console.log('  [CapMonster] Creando task...');

    const { data: createData } = await axios.post('https://api.capmonster.cloud/createTask', {
        clientKey: CAPMONSTER_KEY,
        task: {
            type: 'RecaptchaV2TaskProxyless',
            websiteURL: pageUrl,
            websiteKey: siteKey
        }
    });

    if (createData.errorId) {
        throw new Error(`CapMonster createTask: ${createData.errorDescription}`);
    }

    const taskId = createData.taskId;
    console.log(`  [CapMonster] Task #${taskId} creada. Esperando solucion...`);

    for (let i = 0; i < 60; i++) {
        await sleep(3000);

        const { data } = await axios.post('https://api.capmonster.cloud/getTaskResult', {
            clientKey: CAPMONSTER_KEY,
            taskId
        });

        if (data.status === 'ready') {
            console.log('  [CapMonster] CAPTCHA resuelto!');
            return data.solution.gRecaptchaResponse;
        }
        if (data.errorId) {
            throw new Error(`CapMonster getTaskResult: ${data.errorDescription}`);
        }
    }

    throw new Error('Timeout: CAPTCHA no se resolvio en 3 minutos');
}

// =====================================================================
//  Utilidades
// =====================================================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Extraer y unir cookies de multiples respuestas
function mergeCookies(existing, newSetCookieHeaders) {
    const map = {};
    // Parsear existentes
    if (existing) {
        existing.split('; ').forEach(c => {
            const [k, ...v] = c.split('=');
            if (k) map[k.trim()] = v.join('=');
        });
    }
    // Agregar nuevas
    if (newSetCookieHeaders) {
        const headers = Array.isArray(newSetCookieHeaders) ? newSetCookieHeaders : [newSetCookieHeaders];
        headers.forEach(h => {
            const cookie = h.split(';')[0];
            const [k, ...v] = cookie.split('=');
            if (k) map[k.trim()] = v.join('=');
        });
    }
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Decodificar valor URL-encoded de cookie XSRF
function decodeXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

// Headers comunes para parecer un navegador
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
};

// =====================================================================
//  Extraer reCAPTCHA siteKey de la pagina
// =====================================================================
async function extractSiteKey(html, cookieStr) {
    // 1. data-sitekey en el HTML
    let m = html.match(/data-sitekey=["']([^"']+)["']/);
    if (m) return m[1];

    // 2. render= en script de reCAPTCHA
    m = html.match(/recaptcha[^"']*[?&]render=([^&"']+)/);
    if (m && m[1] !== 'explicit') return m[1];

    // 3. sitekey en config inline
    m = html.match(/sitekey\s*['":\s]+\s*['"]([^'"]{20,})['"]/) ||
        html.match(/site_key\s*['":\s]+\s*['"]([^'"]{20,})['"]/);
    if (m) return m[1];

    // 4. Buscar en los JS bundles (keys reCAPTCHA empiezan con 6L)
    const jsFiles = [];
    const jsRegex = /(?:src|href)=["']([^"']*\/build\/assets\/[^"']+\.js)["']/g;
    let jm;
    while ((jm = jsRegex.exec(html)) !== null) {
        jsFiles.push(jm[1]);
    }

    for (const jsFile of jsFiles.slice(0, 5)) {
        try {
            const url = jsFile.startsWith('http') ? jsFile : `${ESSA_BASE}${jsFile}`;
            const { data: jsCode } = await axios.get(url, {
                headers: { Cookie: cookieStr, ...BROWSER_HEADERS },
                timeout: 10000
            });
            const keyMatch = jsCode.match(/["'](6L[A-Za-z0-9_-]{38,42})["']/);
            if (keyMatch) return keyMatch[1];
        } catch (e) { /* continuar */ }
    }

    return null;
}

// =====================================================================
//  Parsear datos de factura del HTML de sesion
// =====================================================================
function parseInvoiceData(html) {
    const facturas = [];

    // ------------------------------------------------------------------
    //  Metodo 1: Variables de ventana con JSON embebido
    // ------------------------------------------------------------------
    const windowPatterns = [
        /window\.__INITIAL_(?:STATE|DATA)__\s*=\s*(\{[\s\S]*?\});\s*<\/script/,
        /window\.(?:__)?(?:session|microsite|data|bills|invoices)\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script|$)/gm,
        /var\s+(?:session|microsite|data)\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script|$)/gm,
    ];

    for (const pattern of windowPatterns) {
        let wm;
        const regex = new RegExp(pattern.source, pattern.flags || '');
        while ((wm = regex.exec(html)) !== null) {
            try {
                const obj = JSON.parse(wm[1]);
                const bills = obj.bills || obj.invoices || obj.facturas ||
                    obj.data?.bills || obj.data?.invoices || obj.session?.bills;
                if (bills) {
                    return Array.isArray(bills) ? bills : [bills];
                }
            } catch { /* JSON invalido */ }
        }
    }

    // ------------------------------------------------------------------
    //  Metodo 2: JSON en script tags o data attributes
    // ------------------------------------------------------------------
    const $ = cheerio.load(html);

    // data-page attribute (Inertia.js pattern - PlacetoPay usa esto)
    // Buscar data-page en cualquier elemento, no solo #app
    let dataPage = $('#app').attr('data-page');
    if (!dataPage) {
        // Buscar en cualquier div con data-page
        $('[data-page]').each((i, el) => {
            if (!dataPage) dataPage = $(el).attr('data-page');
        });
    }
    if (!dataPage) {
        // Buscar directamente en el HTML con regex (por si cheerio no lo parsea bien)
        const dpMatch = html.match(/data-page="([^"]+)"/);
        if (dpMatch) {
            dataPage = dpMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");
            console.log('  [Inertia] data-page encontrado via regex');
        }
    }
    if (dataPage) {
        try {
            const pageData = JSON.parse(dataPage);
            console.log('  [Inertia] component:', pageData.component);
            console.log('  [Inertia] props keys:', Object.keys(pageData.props || {}));

            if (pageData.props) {
                const props = pageData.props;

                // Log detallado de props para debug
                for (const [key, val] of Object.entries(props)) {
                    const valStr = JSON.stringify(val);
                    console.log(`  [Inertia] props.${key}: ${valStr.substring(0, 200)}`);
                }

                // Buscar facturas/bills en multiples campos posibles
                const bills = props.bills || props.invoices || props.session?.bills ||
                    props.references || props.data?.bills || props.payment?.bills ||
                    props.items || props.session?.invoices || props.session?.references ||
                    props.microsite?.bills;
                if (bills) {
                    return Array.isArray(bills) ? bills : [bills];
                }

                // Si tiene session con datos de pago, devolver todo
                if (props.session || props.payment || props.reference || props.microsite) {
                    return [props];
                }

                // Si hay CUALQUIER prop con array de objetos, podrian ser facturas
                for (const [key, val] of Object.entries(props)) {
                    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                        console.log(`  [Inertia] Encontrado array en props.${key} con ${val.length} items`);
                        return val;
                    }
                }

                // Ultimo recurso: devolver todas las props (excepto app/config)
                const relevantProps = {};
                for (const [key, val] of Object.entries(props)) {
                    if (!['errors', 'jetstream', 'user', 'flash', 'ziggy', 'app'].includes(key)) {
                        relevantProps[key] = val;
                    }
                }
                if (Object.keys(relevantProps).length > 0) {
                    return [relevantProps];
                }
            }
        } catch (e) {
            console.log('  [Inertia] Error parseando data-page:', e.message);
        }
    } else {
        console.log('  [Inertia] No se encontro data-page en #app');
    }

    // Script tags con JSON
    $('script:not([src])').each((i, el) => {
        const text = $(el).html() || '';
        // Buscar asignaciones grandes de JSON
        const assignments = text.match(/=\s*(\{[^;]{100,}\})\s*;/g) || [];
        for (const a of assignments) {
            try {
                const jsonStr = a.replace(/^=\s*/, '').replace(/;\s*$/, '');
                const obj = JSON.parse(jsonStr);
                if (obj && typeof obj === 'object') {
                    facturas.push(obj);
                }
            } catch { /* continuar */ }
        }
    });

    if (facturas.length > 0) return facturas;

    // ------------------------------------------------------------------
    //  Metodo 3: Tablas HTML con datos de factura
    // ------------------------------------------------------------------
    $('table').each((i, table) => {
        const rows = $(table).find('tr');
        const headers = [];
        rows.first().find('th, td').each((j, cell) => {
            headers.push($(cell).text().trim());
        });

        rows.slice(1).each((j, row) => {
            const factura = {};
            $(row).find('td').each((k, cell) => {
                const key = headers[k] || `col_${k}`;
                factura[key] = $(cell).text().trim();
            });
            if (Object.keys(factura).length > 0) {
                facturas.push(factura);
            }
        });
    });

    if (facturas.length > 0) return facturas;

    // ------------------------------------------------------------------
    //  Metodo 4: Buscar patrones de texto con regex
    // ------------------------------------------------------------------
    const bodyText = $.text().replace(/\s+/g, ' ');

    // Patron: valores monetarios COP
    const moneyPattern = /\$\s*([\d.,]+)/g;
    let money;
    const montos = [];
    while ((money = moneyPattern.exec(bodyText)) !== null) {
        montos.push(money[1]);
    }

    // Patron: numeros de factura
    const factNumPattern = /factura\s*(?:N[°o.]?\s*)?:?\s*(\d+)/gi;
    let fn;
    while ((fn = factNumPattern.exec(bodyText)) !== null) {
        const f = { facturaNum: fn[1] };
        if (montos.length > 0) {
            f.monto = '$' + montos.shift();
        }
        facturas.push(f);
    }

    // Si no se encontraron facturas pero hay montos, retornar los montos
    if (facturas.length === 0 && montos.length > 0) {
        montos.forEach((m, i) => {
            facturas.push({ monto: '$' + m, index: i });
        });
    }

    return facturas;
}

// =====================================================================
//  Hacer request HTTP con manejo de cookies
// =====================================================================
async function makeRequest(method, url, { cookies = '', data = null, headers = {}, maxRedirects = 0 } = {}) {
    const config = {
        method,
        url,
        headers: {
            ...BROWSER_HEADERS,
            ...headers,
            Cookie: cookies,
        },
        maxRedirects,
        validateStatus: () => true,
        timeout: 30000,
    };

    if (data) {
        if (typeof data === 'string') {
            config.data = data;
            config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
            config.data = data;
            config.headers['Content-Type'] = 'application/json';
        }
    }

    const resp = await axios(config);
    const newCookies = mergeCookies(cookies, resp.headers['set-cookie']);

    return { status: resp.status, data: resp.data, headers: resp.headers, cookies: newCookies };
}

// =====================================================================
//  Endpoint principal: POST /api/consultar
// =====================================================================
app.post('/api/consultar', async (req, res) => {
    const { cuentas, tipoPago } = req.body;

    if (!cuentas || cuentas.length === 0) {
        return res.status(400).json({ success: false, error: 'Ingrese al menos un numero de cuenta' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Consulta: cuentas=[${cuentas.join(', ')}] tipoPago=${tipoPago}`);
    console.log(`${'='.repeat(60)}`);

    try {
        // =============================================================
        //  PASO 1: Cargar pagina de login → cookies + CSRF + siteKey
        // =============================================================
        console.log('\n[1/5] Cargando pagina de login...');
        const loginResp = await makeRequest('GET', LOGIN_URL);
        let cookies = loginResp.cookies;

        const $ = cheerio.load(loginResp.data);
        const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
        const xsrfToken = decodeXsrf(cookies);

        console.log(`  CSRF meta: ${csrfToken ? csrfToken.substring(0, 20) + '...' : '(no encontrado)'}`);
        console.log(`  XSRF cookie: ${xsrfToken ? xsrfToken.substring(0, 20) + '...' : '(no encontrado)'}`);
        console.log(`  Cookies: ${cookies ? 'OK' : '(vacias)'}`);

        // =============================================================
        //  PASO 2: Extraer reCAPTCHA siteKey
        // =============================================================
        console.log('\n[2/5] Buscando siteKey del reCAPTCHA...');
        let siteKey = await extractSiteKey(loginResp.data, cookies);

        if (!siteKey) {
            console.log('  No se encontro dinamicamente, usando siteKey hardcodeado...');
            siteKey = RECAPTCHA_SITEKEY;
        }
        console.log(`  SiteKey: ${siteKey}`);

        // =============================================================
        //  PASO 3: Resolver CAPTCHA con CapMonster
        // =============================================================
        console.log('\n[3/5] Resolviendo CAPTCHA...');
        const captchaToken = await solveCaptcha(siteKey, LOGIN_URL);

        // =============================================================
        //  PASO 4: Enviar formulario de consulta
        // =============================================================
        console.log('\n[4/5] Enviando formulario...');

        // Mapear tipoPago del frontend al valor numerico de PlacetoPay
        const paymentTypeMap = {
            'total': 1,
            'sin_alumbrado': 2,
            'abonos': 3,
            'saldos': 4
        };
        const paymentType = paymentTypeMap[tipoPago] || 1;

        // Payload exacto como lo envia el frontend real de ESSA
        const jsonBody = {
            search_type: 'account_number',
            payment_type: paymentType,
            account_number: cuentas[0],  // Una cuenta a la vez
            'g-recaptcha-response': captchaToken
        };

        const submitHeaders = {
            'Referer': LOGIN_URL,
            'Origin': ESSA_BASE,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
        };

        if (xsrfToken) {
            submitHeaders['X-XSRF-TOKEN'] = decodeURIComponent(xsrfToken);
        }
        if (csrfToken) {
            submitHeaders['X-CSRF-TOKEN'] = csrfToken;
        }

        console.log('  POST /essa/submit-login (JSON)...');
        console.log('  Body:', JSON.stringify(jsonBody).substring(0, 200));

        let submitResp = await makeRequest('POST', `${ESSA_BASE}/essa/submit-login`, {
            cookies,
            data: jsonBody,
            headers: submitHeaders,
        });

        cookies = submitResp.cookies;
        console.log(`  Status: ${submitResp.status}`);
        console.log(`  Response type: ${typeof submitResp.data}`);
        if (typeof submitResp.data === 'object') {
            console.log(`  Response keys: ${Object.keys(submitResp.data || {}).join(', ')}`);
        }
        if (typeof submitResp.data === 'string') {
            console.log(`  Response preview: ${submitResp.data.substring(0, 300)}`);
        }

        let sessionHtml = null;

        if (submitResp.status >= 300 && submitResp.status < 400) {
            const location = submitResp.headers['location'] || '';
            const redirectUrl = location.startsWith('http') ? location : `${ESSA_BASE}${location}`;
            console.log(`  Redirect -> ${redirectUrl}`);

            const redirectResp = await makeRequest('GET', redirectUrl, { cookies });
            cookies = redirectResp.cookies;
            sessionHtml = typeof redirectResp.data === 'string' ? redirectResp.data : JSON.stringify(redirectResp.data);

            if (redirectUrl.includes('/login') && !redirectUrl.includes('/session')) {
                console.log('  Redireccion a login: formulario rechazado');
                sessionHtml = null;
            }
        } else if (submitResp.status === 200) {
            if (typeof submitResp.data === 'object' && submitResp.data !== null) {
                console.log('  Respuesta JSON recibida:', JSON.stringify(submitResp.data).substring(0, 500));

                // Si tiene URL de redireccion, seguirla
                const returnUrl = submitResp.data.sessionUrl || submitResp.data.url || submitResp.data.returnUrl || submitResp.data.data?.returnUrl;
                if (returnUrl) {
                    const fullUrl = returnUrl.startsWith('http') ? returnUrl : `${ESSA_BASE}${returnUrl}`;
                    console.log(`  Siguiendo sessionUrl -> ${fullUrl}`);

                    // Intento 1: Request como Inertia.js (devuelve JSON directo con props)
                    console.log('  Intento Inertia: GET con X-Inertia header...');
                    const inertiaResp = await makeRequest('GET', fullUrl, {
                        cookies,
                        headers: {
                            'X-Inertia': 'true',
                            'X-Inertia-Version': '',
                            'X-Requested-With': 'XMLHttpRequest',
                            'Accept': 'text/html, application/xhtml+xml',
                        }
                    });
                    cookies = inertiaResp.cookies;

                    if (typeof inertiaResp.data === 'object' && inertiaResp.data !== null) {
                        console.log('  Inertia JSON recibido!');
                        console.log('  Component:', inertiaResp.data.component);
                        console.log('  Props keys:', Object.keys(inertiaResp.data.props || {}));
                        const props = inertiaResp.data.props || {};
                        for (const [key, val] of Object.entries(props)) {
                            console.log(`  props.${key}: ${JSON.stringify(val).substring(0, 300)}`);
                        }
                        // Devolver las props directamente como facturas
                        const bills = props.bills || props.invoices || props.references ||
                            props.session?.bills || props.items || props.payment?.bills;
                        if (bills) {
                            return res.json({ success: true, facturas: Array.isArray(bills) ? bills : [bills], source: 'inertia_props' });
                        }
                        // Si no hay campo especifico de facturas, devolver todas las props utiles
                        const relevantProps = {};
                        for (const [key, val] of Object.entries(props)) {
                            if (!['errors', 'jetstream', 'user', 'flash', 'ziggy', 'app'].includes(key)) {
                                relevantProps[key] = val;
                            }
                        }
                        if (Object.keys(relevantProps).length > 0) {
                            return res.json({ success: true, facturas: [relevantProps], source: 'inertia_all_props' });
                        }
                    }

                    // Intento 2: GET normal (HTML con data-page)
                    console.log('  Intento HTML: GET normal...');
                    const sessionResp = await makeRequest('GET', fullUrl, { cookies });
                    cookies = sessionResp.cookies;
                    sessionHtml = typeof sessionResp.data === 'string' ? sessionResp.data : JSON.stringify(sessionResp.data);
                } else {
                    // Los datos podrian estar directamente en la respuesta JSON
                    return res.json({ success: true, facturas: [submitResp.data], source: 'json_direct' });
                }
            } else {
                sessionHtml = submitResp.data;
            }
        } else {
            console.log(`  Error HTTP ${submitResp.status}`);
            if (typeof submitResp.data === 'string') {
                console.log(`  Body: ${submitResp.data.substring(0, 500)}`);
            } else {
                console.log(`  Body: ${JSON.stringify(submitResp.data).substring(0, 500)}`);
            }
        }

        // Si fallo, intentar con todas las cuentas como array
        if (!sessionHtml && cuentas.length > 0) {
            console.log('  Reintentando con account_number como primer cuenta...');
            // Ya se intento arriba, no reintentar
        }

        if (!sessionHtml) {
            throw new Error('No se recibio respuesta valida del servidor de ESSA. Status: ' + submitResp.status);
        }

        // =============================================================
        //  PASO 5: Parsear datos de factura del HTML
        // =============================================================
        console.log('\n[5/5] Parseando datos de factura...');
        console.log(`  HTML length: ${sessionHtml.length} chars`);
        // Mostrar fragmento del HTML para debug
        if (typeof sessionHtml === 'string') {
            console.log(`  HTML preview (first 500): ${sessionHtml.substring(0, 500)}`);

            // Buscar TODOS los divs con id
            const idMatches = sessionHtml.match(/<div[^>]*id="[^"]*"[^>]*>/g) || [];
            console.log(`  Divs con id: ${idMatches.slice(0, 5).join(' | ')}`);

            // Buscar data-page en cualquier parte
            const dpIdx = sessionHtml.indexOf('data-page');
            if (dpIdx >= 0) {
                console.log(`  data-page encontrado en posicion ${dpIdx}`);
                console.log(`  Contexto: ...${sessionHtml.substring(Math.max(0, dpIdx - 50), dpIdx + 200)}...`);
            } else {
                console.log('  data-page NO encontrado en el HTML');
            }

            // Buscar scripts con datos JSON grandes
            const scriptMatches = sessionHtml.match(/<script[^>]*>([\s\S]{200,}?)<\/script>/g) || [];
            console.log(`  Scripts con contenido largo: ${scriptMatches.length}`);
            for (let i = 0; i < Math.min(scriptMatches.length, 3); i++) {
                console.log(`  Script[${i}] preview: ${scriptMatches[i].substring(0, 200)}`);
            }

            // Buscar cualquier JSON grande embebido
            const jsonInHtml = sessionHtml.match(/\{[^{}]{500,}\}/);
            if (jsonInHtml) {
                console.log(`  JSON grande encontrado: ${jsonInHtml[0].substring(0, 300)}`);
            }
        }

        const facturas = parseInvoiceData(sessionHtml);

        if (facturas.length > 0) {
            console.log(`  Se encontraron ${facturas.length} factura(s)`);
            return res.json({ success: true, facturas });
        }

        // No se encontraron facturas - devolver info para debug
        console.log('  No se encontraron facturas en el HTML');
        const preview = cheerio.load(sessionHtml).text().replace(/\s+/g, ' ').trim().substring(0, 500);
        const currentUrl = submitResp.headers['location'] || 'N/A';

        return res.json({
            success: false,
            message: 'No se encontraron facturas en la respuesta.',
            debug: {
                lastStatus: submitResp.status,
                lastRedirect: currentUrl,
                htmlLength: sessionHtml.length,
                preview: preview,
                tip: 'Si ves "Seleccione el tipo de pago" en preview, los nombres de campo no son correctos. ' +
                    'Abre DevTools en Chrome, envia el formulario manualmente, y revisa la pestana Network ' +
                    'para ver los nombres de campo reales.'
            }
        });

    } catch (err) {
        console.error(`\n  ERROR: ${err.message}`);
        if (err.response) {
            console.error(`  HTTP Status: ${err.response.status}`);
        }
        return res.status(500).json({
            success: false,
            error: err.message,
            tip: 'Revisa la consola del servidor para mas detalles'
        });
    }
});

// =====================================================================
//  Health check
// =====================================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =====================================================================
//  Iniciar servidor
// =====================================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   ESSA Consulta de Facturas - Server     ║`);
    console.log(`  ╠══════════════════════════════════════════╣`);
    console.log(`  ║  Frontend: http://localhost:${PORT}          ║`);
    console.log(`  ║  API:      POST /api/consultar            ║`);
    console.log(`  ║  Health:   GET  /api/health               ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
});
