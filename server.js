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
    // ==================================================================
    // PlacetoPay SPA: los datos estan en atributos HTML codificados
    // con &quot; como props de componentes Vue.js
    // ==================================================================

    // Paso 1: Decodificar HTML entities y extraer TODOS los JSON de atributos
    // Los atributos Vue usan :prop="{&quot;key&quot;:...}"
    console.log('  [Parser] Buscando JSON en atributos HTML...');

    // Extraer JSON completo de atributos Vue - necesitamos balancear llaves
    // porque los JSON son grandes y contienen llaves anidadas
    const allJsonObjects = [];

    // Metodo 1: Buscar atributos que empiezan con {&quot; y balancear llaves
    let searchStart = 0;
    while (true) {
        const idx = html.indexOf('{&quot;', searchStart);
        if (idx === -1) break;

        // Verificar que esta dentro de un atributo (precedido por =")
        const before = html.substring(Math.max(0, idx - 5), idx);
        if (!before.includes('="')) {
            searchStart = idx + 1;
            continue;
        }

        // Encontrar el cierre del atributo: buscar }" que no este escapado
        // El JSON termina cuando encontramos }" seguido de espacio o >
        let depth = 0;
        let pos = idx;
        let endPos = -1;

        // Trabajar con el HTML decodificado parcialmente
        // Buscar el final del atributo (la comilla de cierre despues del JSON)
        const chunk = html.substring(idx);
        // Contar &quot; como comillas, { y } como llaves
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
                    if (depth === 0) {
                        endPos = i + 1;
                        break;
                    }
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
                console.log(`  [Parser] JSON extraido (${decoded.length} chars), keys: ${Object.keys(obj).slice(0, 8).join(', ')}`);
            } catch (e) {
                // Intentar reparar JSON truncado
                if (decoded.length > 200) {
                    console.log(`  [Parser] JSON no valido (${decoded.length} chars): ${e.message}`);
                    console.log(`  [Parser]   Preview: ${decoded.substring(0, 200)}`);
                }
            }
        }

        searchStart = idx + 1;
    }

    console.log(`  [Parser] Encontrados ${allJsonObjects.length} objetos JSON en atributos`);

    // Paso 2: Buscar el objeto principal de sesion (tiene type:"session")
    for (const obj of allJsonObjects) {
        if (obj.type === 'session') {
            console.log('  [Parser] Encontrado objeto type:session');
            console.log('  [Parser] Keys:', Object.keys(obj).join(', '));

            // Buscar facturas/invoices en el objeto de sesion
            const invoiceFields = ['bills', 'invoices', 'references', 'items', 'facturas', 'payments'];
            for (const field of invoiceFields) {
                if (obj[field]) {
                    console.log(`  [Parser] Facturas en session.${field}`);
                    const data = obj[field];
                    return Array.isArray(data) ? data : [data];
                }
            }

            // Buscar dentro de sub-objetos
            for (const [key, val] of Object.entries(obj)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    for (const field of invoiceFields) {
                        if (val[field]) {
                            console.log(`  [Parser] Facturas en session.${key}.${field}`);
                            const data = val[field];
                            const arr = Array.isArray(data) ? data : [data];
                            console.log(`  [Parser] Bills count: ${arr.length}`);
                            console.log(`  [Parser] Bills data: ${JSON.stringify(arr).substring(0, 2000)}`);
                            return arr;
                        }
                    }
                }
                if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                    console.log(`  [Parser] Array en session.${key} con ${val.length} items`);
                    // Si los items tienen amount/total/value, son facturas
                    if (val[0].amount || val[0].total || val[0].value || val[0].reference) {
                        return val;
                    }
                }
            }

            // Devolver el objeto completo de sesion
            console.log('  [Parser] Devolviendo objeto session completo');
            return [obj];
        }
    }

    // Paso 3: Buscar objetos que contengan datos de factura
    for (const obj of allJsonObjects) {
        const keys = Object.keys(obj);
        console.log(`  [Parser] Objeto con keys: ${keys.slice(0, 10).join(', ')}`);

        // Si tiene history.data, es historial de pagos
        if (obj.history?.data) {
            console.log(`  [Parser] Encontrado history.data con ${obj.history.data.length} items`);
        }

        // Buscar arrays con datos de factura
        for (const [key, val] of Object.entries(obj)) {
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                if (val[0].amount || val[0].total || val[0].reference || val[0].invoice) {
                    console.log(`  [Parser] Facturas en obj.${key}`);
                    return val;
                }
            }
        }
    }

    // Paso 4: Si encontramos objetos JSON, devolver TODOS los que tengan datos utiles
    // (incluyendo el que tiene history, settings, etc.)
    if (allJsonObjects.length > 0) {
        console.log('  [Parser] Devolviendo todos los objetos JSON encontrados');
        // Combinar en un solo objeto
        const combined = {};
        for (const obj of allJsonObjects) {
            Object.assign(combined, obj);
        }
        return [combined];
    }

    // Paso 5: Fallback - buscar en cheerio
    const $ = cheerio.load(html);

    // Buscar cualquier elemento con atributos que contengan JSON decodificado
    $('[data-page]').each((i, el) => {
        const dp = $(el).attr('data-page');
        if (dp) {
            try {
                const obj = JSON.parse(dp);
                if (obj.props) return [obj.props];
            } catch {}
        }
    });

    console.log('  [Parser] No se encontraron datos de factura');
    return [];
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

                    // La pagina de sesion es SPA Vue.js - los datos se cargan via AJAX
                    // Probar multiples endpoints API para obtener datos de factura
                    const apiEndpoints = [
                        { url: `${ESSA_BASE}/essa/session`, desc: '/session (JSON)', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
                        { url: `${ESSA_BASE}/essa/session`, desc: '/session (Inertia)', headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '', 'Accept': 'text/html, application/xhtml+xml' } },
                        { url: `${ESSA_BASE}/essa/session/invoices`, desc: '/session/invoices', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
                        { url: `${ESSA_BASE}/essa/session/bills`, desc: '/session/bills', headers: { 'Accept': 'application/json' } },
                        { url: `${ESSA_BASE}/essa/api/session`, desc: '/api/session', headers: { 'Accept': 'application/json' } },
                    ];

                    let foundData = false;
                    for (const ep of apiEndpoints) {
                        console.log(`  Probando ${ep.desc}...`);
                        try {
                            const apiResp = await makeRequest('GET', ep.url, {
                                cookies,
                                headers: { ...ep.headers, 'Referer': fullUrl }
                            });
                            cookies = apiResp.cookies;
                            console.log(`    Status: ${apiResp.status}, Type: ${typeof apiResp.data}`);

                            if (apiResp.status === 200 && typeof apiResp.data === 'object' && apiResp.data !== null) {
                                const keys = Object.keys(apiResp.data);
                                console.log(`    Keys: ${keys.join(', ')}`);
                                console.log(`    Full response: ${JSON.stringify(apiResp.data).substring(0, 2000)}`);

                                // Inertia response
                                if (apiResp.data.component && apiResp.data.props) {
                                    console.log(`    INERTIA! component: ${apiResp.data.component}`);
                                    const props = apiResp.data.props;
                                    for (const [key, val] of Object.entries(props)) {
                                        console.log(`    props.${key}: ${JSON.stringify(val).substring(0, 500)}`);
                                    }
                                    const bills = props.bills || props.invoices || props.references ||
                                        props.session?.bills || props.items || props.payment;
                                    if (bills) {
                                        return res.json({ success: true, facturas: Array.isArray(bills) ? bills : [bills], source: 'inertia' });
                                    }
                                    const relevantProps = {};
                                    for (const [key, val] of Object.entries(props)) {
                                        if (!['errors', 'jetstream', 'user', 'flash', 'ziggy'].includes(key)) {
                                            relevantProps[key] = val;
                                        }
                                    }
                                    if (Object.keys(relevantProps).length > 0) {
                                        return res.json({ success: true, facturas: [relevantProps], source: 'inertia_props' });
                                    }
                                }

                                // JSON directo
                                if (apiResp.data.data || apiResp.data.bills || apiResp.data.invoices) {
                                    const data = apiResp.data.data || apiResp.data.bills || apiResp.data.invoices;
                                    return res.json({ success: true, facturas: Array.isArray(data) ? data : [data], source: 'api_json' });
                                }
                            } else if (apiResp.status >= 300 && apiResp.status < 400) {
                                console.log(`    Redirect: ${apiResp.headers['location'] || 'unknown'}`);
                            }
                        } catch (e) {
                            console.log(`    Error: ${e.message}`);
                        }
                    }

                    // Ultimo recurso: GET HTML de sesion y parsear
                    console.log('  Cargando HTML de sesion para parsear...');
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

            // Buscar TODOS los JSON grandes embebidos (con &quot;)
            const quotedJsons = sessionHtml.match(/\{(?:&quot;|&#34;)[^<]{200,}?\}/g) || [];
            console.log(`  JSONs con &quot; encontrados: ${quotedJsons.length}`);
            for (let i = 0; i < Math.min(quotedJsons.length, 5); i++) {
                const decoded = quotedJsons[i].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&#34;/g, '"');
                console.log(`  QuotedJSON[${i}] (${decoded.length} chars): ${decoded.substring(0, 500)}`);
                try {
                    const obj = JSON.parse(decoded);
                    console.log(`  QuotedJSON[${i}] keys: ${Object.keys(obj).join(', ')}`);
                    // Si tiene datos de factura, usarlos
                    if (obj.bills || obj.invoices || obj.references || obj.items) {
                        const data = obj.bills || obj.invoices || obj.references || obj.items;
                        facturas.push(...(Array.isArray(data) ? data : [data]));
                    }
                } catch(e) { /* no es JSON valido */ }
            }

            // Buscar JSON normal grande
            const jsonInHtml = sessionHtml.match(/\{[^{}]{500,}\}/);
            if (jsonInHtml) {
                console.log(`  JSON grande normal: ${jsonInHtml[0].substring(0, 300)}`);
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
