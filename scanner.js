// ══════════════════════════════════════════════════════
//  COINVERTER — scanner.js
// ══════════════════════════════════════════════════════

// ── ELEMENTOS DOM ─────────────────────────────────────
const video       = document.getElementById('video');
const frozenImg   = document.getElementById('frozen-img');
const scanLine    = document.getElementById('scan-line');
const camBadge    = document.getElementById('cam-badge');
const procOverlay = document.getElementById('proc-overlay');
const btnShutter  = document.getElementById('btn-shutter');
const btnRetry    = document.getElementById('btn-retry');
const resVal      = document.getElementById('result-value');
const convVal     = document.getElementById('converted-value');
const fromC       = document.getElementById('from-currency');
const toC         = document.getElementById('to-currency');
const fromTag     = document.getElementById('from-tag');
const toTag       = document.getElementById('to-tag');
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d', { willReadFrequently: true });

// ── ESTADO ────────────────────────────────────────────
// Tasas base USD — se sobreescriben con datos reales
// ARS oficial ~1100, EUR ~0.92 (Feb 2026)
let rates = { USD: 1, ARS: 1100, EUR: 0.92 };
let worker  = null;
let lastNum = null;
let frozen  = false;

// ══════════════════════════════════════════════════════
//  TASAS EN TIEMPO REAL
// ══════════════════════════════════════════════════════

async function updateRates() {
    // Intentar cargar cache válido (< 1 hora)
    try {
        const cached   = JSON.parse(localStorage.getItem('coinverter_rates') || 'null');
        const cachedAt = parseInt(localStorage.getItem('coinverter_rates_ts') || '0');
        if (cached && cached.ARS && (Date.now() - cachedAt) < 3600000) {
            rates = cached;
            console.log('[Rates] Cache OK — ARS:', rates.ARS, 'EUR:', rates.EUR);
            showRateBadge();
            return;
        }
    } catch(e) {}

    // API 1: open.er-api.com (gratuita, sin key)
    try {
        const res  = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data?.rates?.ARS) {
            rates = { USD: 1, ARS: data.rates.ARS, EUR: data.rates.EUR };
            saveRates();
            console.log('[Rates] API1 OK — ARS:', rates.ARS, 'EUR:', rates.EUR);
            showRateBadge();
            return;
        }
    } catch(e) { console.warn('[Rates] API1 falló'); }

    // API 2: frankfurter.app (backup)
    try {
        const res  = await fetch('https://api.frankfurter.app/latest?from=USD&to=ARS,EUR');
        const data = await res.json();
        if (data?.rates?.EUR) {
            rates = { USD: 1, ARS: data.rates.ARS || 1100, EUR: data.rates.EUR };
            saveRates();
            console.log('[Rates] API2 OK — EUR:', rates.EUR);
            showRateBadge();
            return;
        }
    } catch(e) { console.warn('[Rates] API2 falló'); }

    // Fallback: usar valores hardcodeados y avisarle al usuario
    console.warn('[Rates] Usando tasas de referencia offline.');
    showRateBadge(true);
}

function saveRates() {
    localStorage.setItem('coinverter_rates',    JSON.stringify(rates));
    localStorage.setItem('coinverter_rates_ts', Date.now());
}

function showRateBadge(offline = false) {
    const arsStr = rates.ARS >= 1 ? rates.ARS.toFixed(0) : rates.ARS.toFixed(4);
    const eurStr = rates.EUR.toFixed(4);
    const msg    = offline
        ? `⚠️ Sin conexión · valores de referencia`
        : `1 USD = ${arsStr} ARS · ${eurStr} EUR`;
    setCamBadge(msg, offline ? 'error' : '');
    setTimeout(() => setCamBadge('Listo para escanear', ''), 4000);
}

// ══════════════════════════════════════════════════════
//  CONVERSIÓN
//  Todas las tasas son "cuántas unidades por 1 USD"
//  Para convertir X de moneda A → B:
//    X_en_USD = X / rates[A]
//    resultado = X_en_USD * rates[B]
// ══════════════════════════════════════════════════════

function convert(amount, from, to) {
    if (from === to) return amount;
    const inUSD = amount / (rates[from] || 1);
    return inUSD * (rates[to] || 1);
}

// ══════════════════════════════════════════════════════
//  FORMATO DE NÚMERO — máximo 2 decimales, sin ceros extra
// ══════════════════════════════════════════════════════

function formatAmount(num, currency) {
    // JPY y monedas sin decimales → 0 decimales
    const noDecimals = ['JPY', 'CLP', 'PYG'];
    if (noDecimals.includes(currency)) {
        return Math.round(num).toLocaleString('es-AR');
    }

    // Para el resto: máximo 2 decimales, sin ceros innecesarios
    // ej: 3.10 → "3,10" | 3.1 → "3,1" | 3.00 → "3"
    const fixed2 = parseFloat(num.toFixed(2));
    return fixed2.toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

// ══════════════════════════════════════════════════════
//  PREPROCESAMIENTO — Umbral Otsu
// ══════════════════════════════════════════════════════

function preprocessOtsu() {
    const w = canvas.width, h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d       = imgData.data;
    const gray    = new Uint8Array(w * h);
    const hist    = new Int32Array(256);

    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const g = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) | 0;
        gray[j] = g; hist[g]++;
    }

    const total = w * h;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, max = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (!wB) continue;
        const wF = total - wB; if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) ** 2;
        if (between > max) { max = between; threshold = t; }
    }
    for (let j = 0; j < gray.length; j++) {
        const v = gray[j] > threshold ? 255 : 0;
        const i = j * 4;
        d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
}

// ══════════════════════════════════════════════════════
//  EXTRACCIÓN DE NÚMERO
// ══════════════════════════════════════════════════════

function extractBestNumber(text) {
    const clean   = text.replace(/[$€£¥₹]/g, '').replace(/[^\d.,\s]/g, ' ').trim();
    const matches = clean.match(/\d[\d.,]*/g);
    if (!matches) return null;

    let best = matches.reduce((a, b) => b.length > a.length ? b : a, '');

    if      (/\d{1,3}(\.\d{3})+(,\d+)?$/.test(best)) best = best.replace(/\./g, '').replace(',', '.');
    else if (/\d{1,3}(,\d{3})+(\.\d+)?$/.test(best)) best = best.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(best))              best = best.replace(',', '.');
    else if (/^\d+\.\d{3}$/.test(best))               best = best.replace('.', '');

    const num = parseFloat(best);
    return (!isNaN(num) && num > 0 && num < 999_999_999) ? num : null;
}

// ══════════════════════════════════════════════════════
//  CAPTURA Y OCR
// ══════════════════════════════════════════════════════

async function captureFrame() {
    if (frozen) return;
    frozen = true;
    btnShutter.disabled = true;
    scanLine.classList.add('paused');

    const vw = video.videoWidth  || 640;
    const vh = video.videoHeight || 480;

    // Congelar frame visible
    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(video, 0, 0);
    frozenImg.src = canvas.toDataURL('image/jpeg', 0.95);
    frozenImg.style.display = 'block';

    procOverlay.classList.add('visible');
    setCamBadge('Leyendo precio...', 'scan');

    try {
        // Recortar zona del scan-box
        const cropX = Math.floor(vw * 0.11);
        const cropY = Math.floor(vh * 0.31);
        const cropW = Math.floor(vw * 0.78);
        const cropH = Math.floor(vh * 0.38);

        canvas.width  = cropW * 2;
        canvas.height = cropH * 2;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
        preprocessOtsu();

        const { data: { text, confidence } } = await worker.recognize(canvas);
        console.log('[OCR]', JSON.stringify(text), '| conf:', confidence.toFixed(1));

        const num = extractBestNumber(text);

        if (num !== null) {
            lastNum = num;
            showResult(num);
            setCamBadge('✓ Precio detectado', 'ok');
            showRetry(true);
        } else {
            setCamBadge('No encontré un número. Acercate más.', 'error');
            showRetry(true);
            setTimeout(retryCapture, 3000);
        }

    } catch(e) {
        console.error('[OCR Error]', e);
        setCamBadge('Error al leer. Reintentá.', 'error');
        setTimeout(retryCapture, 2000);
    }

    procOverlay.classList.remove('visible');
}

function retryCapture() {
    frozen = false;
    frozenImg.style.display = 'none';
    frozenImg.src = '';
    scanLine.classList.remove('paused');
    btnShutter.disabled = false;
    showRetry(false);
    setCamBadge('Listo para escanear', '');
}

// ══════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════

function showResult(num) {
    const from   = fromC.value;
    const to     = toC.value;
    const result = convert(num, from, to);

    console.log(`[Convert] ${num} ${from} → ${to} | rates[${from}]=${rates[from]} rates[${to}]=${rates[to]} | result=${result}`);

    resVal.innerText  = formatAmount(num, from);
    convVal.innerText = formatAmount(result, to);
}

function setCamBadge(msg, type) {
    camBadge.textContent = msg;
    camBadge.className   = 'cam-status-badge' + (type ? ' ' + type : '');
}

function showRetry(show) {
    btnRetry.classList.toggle('visible', show);
}

function swapCurrencies() {
    const tmp   = fromC.value;
    fromC.value = toC.value;
    toC.value   = tmp;
    updateCurrencyTags();
    if (lastNum) showResult(lastNum);
}

function updateCurrencyTags() {
    fromTag.textContent = fromC.value;
    toTag.textContent   = toC.value;
}

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════

async function init() {
    setCamBadge('Cargando...', '');
    await updateRates();

    worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
    await worker.setParameters({
        tessedit_char_whitelist: '0123456789.,',
        tessedit_pageseg_mode:   '6',
        tessedit_ocr_engine_mode:'2',
        user_defined_dpi:        '200',
    });

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => {
            btnShutter.disabled = false;
        });
    } catch(e) {
        setCamBadge('Sin acceso a la cámara', 'error');
    }
}

// ── EVENTOS ───────────────────────────────────────────
[fromC, toC].forEach(s => s.addEventListener('change', () => {
    updateCurrencyTags();
    if (lastNum) showResult(lastNum);
}));

window.addEventListener('load', init);