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
//  CACHE - Reutilizar sesion y CAPTCHA entre consultas
// =====================================================================
const cache = {
    // Sesion de ESSA (cookies + tokens)
    session: null,
    sessionTime: 0,
    SESSION_TTL: 10 * 60 * 1000, // 10 min - sesion de PlacetoPay dura ~30min

    // Token de CAPTCHA resuelto
    captchaToken: null,
    captchaTime: 0,
    CAPTCHA_TTL: 100 * 1000, // 100 seg - token reCAPTCHA v2 dura ~120seg

    isSessionValid() {
        return this.session && (Date.now() - this.sessionTime) < this.SESSION_TTL;
    },
    isCaptchaValid() {
        return this.captchaToken && (Date.now() - this.captchaTime) < this.CAPTCHA_TTL;
    },
    setSession(data) {
        this.session = data;
        this.sessionTime = Date.now();
    },
    setCaptcha(token) {
        this.captchaToken = token;
        this.captchaTime = Date.now();
    },
    invalidateSession() {
        this.session = null;
        this.sessionTime = 0;
    },
    invalidateCaptcha() {
        this.captchaToken = null;
        this.captchaTime = 0;
    }
};

// =====================================================================
//  CapMonster - Resolver reCAPTCHA v2
// =====================================================================
async function solveCaptcha() {
    // Reutilizar token si aun es valido
    if (cache.isCaptchaValid()) {
        console.log('  [CapMonster] Reutilizando token en cache');
        const token = cache.captchaToken;
        cache.invalidateCaptcha(); // Solo usar una vez
        return token;
    }

    console.log('  [CapMonster] Creando task...');
    const { data: createData } = await axios.post('https://api.capmonster.cloud/createTask', {
        clientKey: CAPMONSTER_KEY,
        task: {
            type: 'RecaptchaV2TaskProxyless',
            websiteURL: LOGIN_URL,
            websiteKey: RECAPTCHA_SITEKEY
        }
    });

    if (createData.errorId) {
        throw new Error(`CapMonster createTask: ${createData.errorDescription}`);
    }

    const taskId = createData.taskId;
    console.log(`  [CapMonster] Task #${taskId} - esperando...`);

    for (let i = 0; i < 60; i++) {
        await sleep(3000);
        const { data } = await axios.post('https://api.capmonster.cloud/getTaskResult', {
            clientKey: CAPMONSTER_KEY,
            taskId
        });

        if (data.status === 'ready') {
            console.log('  [CapMonster] Resuelto!');
            return data.solution.gRecaptchaResponse;
        }
        if (data.errorId) {
            throw new Error(`CapMonster: ${data.errorDescription}`);
        }
    }

    throw new Error('Timeout: CAPTCHA no resuelto en 3 min');
}

// =====================================================================
//  Utilidades
// =====================================================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function mergeCookies(existing, newSetCookieHeaders) {
    const map = {};
    if (existing) {
        existing.split('; ').forEach(c => {
            const [k, ...v] = c.split('=');
            if (k) map[k.trim()] = v.join('=');
        });
    }
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

function decodeXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
};

// =====================================================================
//  Parsear datos de factura del HTML de sesion
// =====================================================================
function parseInvoiceData(html) {
    console.log('  [Parser] Extrayendo JSON de atributos Vue...');

    const allJsonObjects = [];
    let searchStart = 0;

    while (true) {
        const idx = html.indexOf('{&quot;', searchStart);
        if (idx === -1) break;

        const before = html.substring(Math.max(0, idx - 5), idx);
        if (!before.includes('="')) {
            searchStart = idx + 1;
            continue;
        }

        let depth = 0;
        let endPos = -1;
        const chunk = html.substring(idx);
        let inStr = false;
        let i = 0;

        while (i < chunk.length) {
            if (chunk.substring(i, i + 6) === '&quot;') {
                inStr = !inStr;
                i += 6;
                continue;
            }
            if (!inStr) {
                if (chunk[i] === '{') depth++;
                if (chunk[i] === '}') {
                    depth--;
                    if (depth === 0) { endPos = i + 1; break; }
                }
            }
            i++;
        }

        if (endPos > 0) {
            const raw = chunk.substring(0, endPos);
            const decoded = raw
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&#039;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&#34;/g, '"')
                .replace(/\\\//g, '/');

            try {
                const obj = JSON.parse(decoded);
                allJsonObjects.push(obj);
            } catch (e) { /* JSON invalido, ignorar */ }
        }

        searchStart = idx + 1;
    }

    console.log(`  [Parser] ${allJsonObjects.length} objetos JSON encontrados`);

    // Buscar objeto type:session → session.bills
    for (const obj of allJsonObjects) {
        if (obj.type === 'session') {
            console.log('  [Parser] Objeto type:session encontrado');

            const invoiceFields = ['bills', 'invoices', 'references', 'items', 'facturas', 'payments'];

            // Directo en session
            for (const field of invoiceFields) {
                if (obj[field]) {
                    let data = obj[field];
                    if (data && typeof data === 'object' && !Array.isArray(data) && data.data) {
                        data = data.data;
                    }
                    return Array.isArray(data) ? data : [data];
                }
            }

            // Dentro de sub-objetos (session.session.bills)
            for (const [key, val] of Object.entries(obj)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    for (const field of invoiceFields) {
                        if (val[field]) {
                            let data = val[field];
                            if (data && typeof data === 'object' && !Array.isArray(data) && data.data) {
                                console.log(`  [Parser] Desanidando ${key}.${field}.data`);
                                data = data.data;
                            }
                            const arr = Array.isArray(data) ? data : [data];
                            console.log(`  [Parser] ${arr.length} factura(s) en session.${key}.${field}`);
                            return arr;
                        }
                    }
                }
            }

            return [obj];
        }
    }

    // Fallback: buscar objetos con datos de factura
    for (const obj of allJsonObjects) {
        for (const [key, val] of Object.entries(obj)) {
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                if (val[0].amount || val[0].total || val[0].reference || val[0].totalAmount) {
                    return val;
                }
            }
        }
    }

    console.log('  [Parser] No se encontraron facturas');
    return [];
}

// =====================================================================
//  HTTP request con cookies
// =====================================================================
async function makeRequest(method, url, { cookies = '', data = null, headers = {}, maxRedirects = 0 } = {}) {
    const config = {
        method, url,
        headers: { ...BROWSER_HEADERS, ...headers, Cookie: cookies },
        maxRedirects,
        validateStatus: () => true,
        timeout: 30000,
    };

    if (data) {
        config.data = data;
        config.headers['Content-Type'] = typeof data === 'string'
            ? 'application/x-www-form-urlencoded'
            : 'application/json';
    }

    const resp = await axios(config);
    return {
        status: resp.status,
        data: resp.data,
        headers: resp.headers,
        cookies: mergeCookies(cookies, resp.headers['set-cookie'])
    };
}

// =====================================================================
//  Obtener sesion ESSA (login page → cookies + CSRF)
// =====================================================================
async function getEssaSession() {
    if (cache.isSessionValid()) {
        console.log('  [Sesion] Reutilizando sesion en cache');
        return cache.session;
    }

    console.log('  [Sesion] Creando nueva sesion...');
    const loginResp = await makeRequest('GET', LOGIN_URL);
    const cookies = loginResp.cookies;
    const $ = cheerio.load(loginResp.data);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    const xsrfToken = decodeXsrf(cookies);

    const session = { cookies, csrfToken, xsrfToken };
    cache.setSession(session);
    console.log('  [Sesion] Nueva sesion creada');
    return session;
}

// =====================================================================
//  Endpoint principal: POST /api/consultar
// =====================================================================
app.post('/api/consultar', async (req, res) => {
    const { cuentas, tipoPago } = req.body;

    if (!cuentas || cuentas.length === 0) {
        return res.status(400).json({ success: false, error: 'Ingrese al menos un numero de cuenta' });
    }

    const startTime = Date.now();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Consulta: cuenta=${cuentas[0]} tipoPago=${tipoPago}`);
    console.log(`${'='.repeat(50)}`);

    try {
        // PASO 1: Obtener sesion (cache o nueva)
        console.log('\n[1/4] Sesion ESSA...');
        let session = await getEssaSession();
        let { cookies, csrfToken, xsrfToken } = session;

        // PASO 2: Resolver CAPTCHA (no se puede cachear - cada submit necesita uno nuevo)
        console.log('\n[2/4] Resolviendo CAPTCHA...');
        const captchaToken = await solveCaptcha();

        // PASO 3: Enviar formulario
        console.log('\n[3/4] Enviando formulario...');
        const paymentTypeMap = { 'total': 1, 'sin_alumbrado': 2, 'abonos': 3, 'saldos': 4 };
        const paymentType = paymentTypeMap[tipoPago] || 1;

        const submitHeaders = {
            'Referer': LOGIN_URL,
            'Origin': ESSA_BASE,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
        };
        if (xsrfToken) submitHeaders['X-XSRF-TOKEN'] = decodeURIComponent(xsrfToken);
        if (csrfToken) submitHeaders['X-CSRF-TOKEN'] = csrfToken;

        let submitResp = await makeRequest('POST', `${ESSA_BASE}/essa/submit-login`, {
            cookies,
            data: {
                search_type: 'account_number',
                payment_type: paymentType,
                account_number: cuentas[0],
                'g-recaptcha-response': captchaToken
            },
            headers: submitHeaders,
        });

        cookies = submitResp.cookies;
        console.log(`  Status: ${submitResp.status}`);

        // Si la sesion expiro (redirect a login o 419), invalidar cache y reintentar
        if (submitResp.status === 419 ||
            (submitResp.status >= 300 && submitResp.status < 400 &&
             (submitResp.headers['location'] || '').includes('/login'))) {
            console.log('  Sesion expirada, renovando...');
            cache.invalidateSession();
            session = await getEssaSession();
            cookies = session.cookies;
            xsrfToken = session.xsrfToken;
            csrfToken = session.csrfToken;

            if (xsrfToken) submitHeaders['X-XSRF-TOKEN'] = decodeURIComponent(xsrfToken);
            if (csrfToken) submitHeaders['X-CSRF-TOKEN'] = csrfToken;

            // Necesitamos nuevo CAPTCHA para la nueva sesion
            console.log('  Resolviendo nuevo CAPTCHA...');
            const newCaptcha = await solveCaptcha();

            submitResp = await makeRequest('POST', `${ESSA_BASE}/essa/submit-login`, {
                cookies,
                data: {
                    search_type: 'account_number',
                    payment_type: paymentType,
                    account_number: cuentas[0],
                    'g-recaptcha-response': newCaptcha
                },
                headers: submitHeaders,
            });
            cookies = submitResp.cookies;
            console.log(`  Retry status: ${submitResp.status}`);
        }

        let sessionHtml = null;

        if (submitResp.status >= 300 && submitResp.status < 400) {
            const location = submitResp.headers['location'] || '';
            const redirectUrl = location.startsWith('http') ? location : `${ESSA_BASE}${location}`;
            console.log(`  Redirect -> ${redirectUrl}`);

            if (redirectUrl.includes('/login')) {
                throw new Error('ESSA rechazo la consulta (redirect a login)');
            }

            const redirectResp = await makeRequest('GET', redirectUrl, { cookies });
            cookies = redirectResp.cookies;
            sessionHtml = typeof redirectResp.data === 'string' ? redirectResp.data : JSON.stringify(redirectResp.data);

        } else if (submitResp.status === 200 && typeof submitResp.data === 'object') {
            const returnUrl = submitResp.data.sessionUrl || submitResp.data.url || submitResp.data.returnUrl;
            if (returnUrl) {
                const fullUrl = returnUrl.startsWith('http') ? returnUrl : `${ESSA_BASE}${returnUrl}`;
                console.log(`  sessionUrl -> ${fullUrl}`);

                // Ir DIRECTO al HTML (los endpoints API siempre dan 404)
                const sessionResp = await makeRequest('GET', fullUrl, { cookies });
                cookies = sessionResp.cookies;
                sessionHtml = typeof sessionResp.data === 'string' ? sessionResp.data : JSON.stringify(sessionResp.data);
            } else {
                return res.json({ success: true, facturas: [submitResp.data], source: 'json_direct' });
            }
        } else if (submitResp.status !== 200) {
            throw new Error(`ESSA respondio con status ${submitResp.status}`);
        } else {
            sessionHtml = typeof submitResp.data === 'string' ? submitResp.data : JSON.stringify(submitResp.data);
        }

        if (!sessionHtml) {
            throw new Error('No se recibio respuesta valida de ESSA');
        }

        // PASO 4: Parsear HTML
        console.log('\n[4/4] Parseando facturas...');
        const facturas = parseInvoiceData(sessionHtml);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (facturas.length > 0) {
            console.log(`  ✓ ${facturas.length} factura(s) encontrada(s) en ${elapsed}s`);
            return res.json({ success: true, facturas });
        }

        console.log(`  ✗ 0 facturas en ${elapsed}s`);
        return res.json({
            success: false,
            message: 'No se encontraron facturas en la respuesta.',
            debug: { htmlLength: sessionHtml.length }
        });

    } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`  ERROR (${elapsed}s): ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =====================================================================
//  Pre-calentar: resolver CAPTCHA en background al iniciar
// =====================================================================
async function precalentarCaptcha() {
    try {
        console.log('\n  [Precalentar] Resolviendo CAPTCHA anticipado...');
        const token = await solveCaptcha();
        cache.setCaptcha(token);
        console.log('  [Precalentar] CAPTCHA listo en cache!');
    } catch (e) {
        console.log(`  [Precalentar] Error: ${e.message}`);
    }
}

// =====================================================================
//  Health check + stats
// =====================================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: {
            sessionValid: cache.isSessionValid(),
            captchaValid: cache.isCaptchaValid(),
            sessionAge: cache.session ? Math.round((Date.now() - cache.sessionTime) / 1000) + 's' : null,
        }
    });
});

// =====================================================================
//  Iniciar servidor
// =====================================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   ESSA Consulta - Server OPTIMIZADO      ║`);
    console.log(`  ╠══════════════════════════════════════════╣`);
    console.log(`  ║  Frontend: http://localhost:${PORT}          ║`);
    console.log(`  ║  API:      POST /api/consultar            ║`);
    console.log(`  ║  Health:   GET  /api/health               ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);

    // Pre-calentar: obtener sesion y CAPTCHA antes de la primera consulta
    getEssaSession().then(() => {
        console.log('  [Startup] Sesion ESSA pre-cargada');
        precalentarCaptcha();
    }).catch(e => {
        console.log(`  [Startup] Pre-carga fallida: ${e.message}`);
    });
});
