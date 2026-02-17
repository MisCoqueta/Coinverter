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
let rates = { USD: 1, ARS: 1100, EUR: 0.92 };
let worker  = null;
let lastNum = null;
let frozen  = false;
let isOCRLoaded = false; 

// ══════════════════════════════════════════════════════
//  TASAS EN TIEMPO REAL
// ══════════════════════════════════════════════════════

async function updateRates() {
    try {
        const cached = JSON.parse(localStorage.getItem('coinverter_rates') || 'null');
        const cachedAt = parseInt(localStorage.getItem('coinverter_rates_ts') || '0');
        if (cached && cached.ARS && (Date.now() - cachedAt) < 3600000) {
            rates = cached;
            return;
        }
    } catch(e) {}

    try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data?.rates?.ARS) {
            rates = { USD: 1, ARS: data.rates.ARS, EUR: data.rates.EUR };
            localStorage.setItem('coinverter_rates', JSON.stringify(rates));
            localStorage.setItem('coinverter_rates_ts', Date.now());
        }
    } catch(e) { console.warn('Usando tasas offline/cache'); }
}

// ══════════════════════════════════════════════════════
//  CONVERSIÓN Y FORMATO
// ══════════════════════════════════════════════════════

function convert(amount, from, to) {
    if (from === to) return amount;
    const inUSD = amount / (rates[from] || 1);
    return inUSD * (rates[to] || 1);
}

function formatAmount(num, currency) {
    const noDecimals = ['JPY', 'CLP', 'PYG'];
    if (noDecimals.includes(currency)) {
        return Math.round(num).toLocaleString('es-AR');
    }
    return parseFloat(num.toFixed(2)).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

// ══════════════════════════════════════════════════════
//  PROCESAMIENTO DE IMAGEN (Otsu)
// ══════════════════════════════════════════════════════

function preprocessOtsu() {
    const w = canvas.width, h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const gray = new Uint8Array(w * h);
    const hist = new Int32Array(256);

    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const g = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) | 0;
        gray[j] = g; hist[g]++;
    }
    
    let sum = 0, sumB = 0, wB = 0, wF = 0, mB, mF, max = 0, threshold = 128;
    const total = w * h;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (wB === 0) continue;
        wF = total - wB; if (wF === 0) break;
        sumB += t * hist[t];
        mB = sumB / wB; mF = (sum - sumB) / wF;
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
//  LÓGICA DE EXTRACCIÓN NUMÉRICA (FIX ARGENTINA)
// ══════════════════════════════════════════════════════

function extractBestNumber(text) {
    // 1. Limpieza: quitar símbolos de moneda y espacios extra
    const clean = text.replace(/[$€£¥₹]/g, '').trim();

    // 2. Buscar bloques que parezcan números (dígitos, puntos y comas)
    //    Ej: "1.000", "504.020", "1.500,50"
    const matches = clean.match(/[\d]+([.,][\d]+)*/g);
    
    if (!matches) return null;

    // Tomamos el candidato más largo (asumiendo que es el precio principal)
    let best = matches.reduce((a, b) => b.length > a.length ? b : a, '');
    
    // ── LÓGICA DE INTERPRETACIÓN ──

    // Caso A: Tiene AMBOS (punto y coma) -> Ej: 1.500,00
    // Asumimos formato AR/EU: Puntos son miles, Coma es decimal.
    if (best.includes('.') && best.includes(',')) {
        best = best.replace(/\./g, '').replace(',', '.');
    }
    // Caso B: Solo tiene PUNTOS -> Ej: 1.000 o 504.020
    // Javascript piensa que "1.000" es 1. Nosotros queremos 1000.
    else if (best.includes('.')) {
        const parts = best.split('.');
        const lastPart = parts[parts.length - 1];

        // Si después del último punto hay EXACTAMENTE 3 dígitos (ej: .000, .020)
        // O si hay múltiples puntos (1.000.000) -> Son MILES.
        if (parts.length > 2 || lastPart.length === 3) {
            best = best.replace(/\./g, ''); // Quitamos los puntos
        } else {
            // Si hay 2 dígitos (ej: 10.50), asumimos que es un precio decimal estilo USA
            // No hacemos nada, parseFloat lo entenderá.
        }
    }
    // Caso C: Solo tiene COMAS -> Ej: 1500,50
    // Reemplazamos coma por punto para Javascript
    else if (best.includes(',')) {
        best = best.replace(',', '.');
    }

    const num = parseFloat(best);
    // Filtros de seguridad: que sea número, mayor a 0 y menor a mil millones
    return (!isNaN(num) && num > 0 && num < 999999999) ? num : null;
}

// ══════════════════════════════════════════════════════
//  CAPTURA Y OCR
// ══════════════════════════════════════════════════════

async function captureFrame() {
    if (frozen) return;
    
    if (!isOCRLoaded) {
        setCamBadge('El OCR aún está cargando...', 'scan');
        return;
    }

    frozen = true;
    btnShutter.disabled = true;
    scanLine.classList.add('paused');

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(video, 0, 0);
    frozenImg.src = canvas.toDataURL('image/jpeg', 0.90);
    frozenImg.style.display = 'block';

    procOverlay.classList.add('visible');
    setCamBadge('Procesando...', 'scan');

    try {
        const cropX = Math.floor(vw * 0.10);
        const cropY = Math.floor(vh * 0.30);
        const cropW = Math.floor(vw * 0.80);
        const cropH = Math.floor(vh * 0.40);

        canvas.width = cropW;
        canvas.height = cropH;
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        preprocessOtsu();

        const { data: { text } } = await worker.recognize(canvas);
        const num = extractBestNumber(text);

        if (num !== null) {
            lastNum = num;
            showResult(num);
            setCamBadge('✓ Precio detectado', 'ok');
            showRetry(true);
        } else {
            setCamBadge('No se detectó número', 'error');
            showRetry(true);
            setTimeout(retryCapture, 2500);
        }

    } catch(e) {
        console.error(e);
        setCamBadge('Error al leer', 'error');
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
    setCamBadge(isOCRLoaded ? 'Listo para escanear' : 'Cargando OCR...', '');
}

// ══════════════════════════════════════════════════════
//  INTERFAZ
// ══════════════════════════════════════════════════════

function showResult(num) {
    const from = fromC.value;
    const to = toC.value;
    resVal.innerText = formatAmount(num, from);
    convVal.innerText = formatAmount(convert(num, from, to), to);
}

function setCamBadge(msg, type) {
    camBadge.textContent = msg;
    camBadge.className = 'cam-status-badge' + (type ? ' ' + type : '');
}

function showRetry(show) {
    btnRetry.classList.toggle('visible', show);
}

function swapCurrencies() {
    const tmp = fromC.value; fromC.value = toC.value; toC.value = tmp;
    fromTag.textContent = fromC.value; toTag.textContent = toC.value;
    if (lastNum) showResult(lastNum);
}

[fromC, toC].forEach(s => s.addEventListener('change', () => {
    fromTag.textContent = fromC.value;
    toTag.textContent = toC.value;
    if (lastNum) showResult(lastNum);
}));

// ══════════════════════════════════════════════════════
//  INICIALIZACIÓN
// ══════════════════════════════════════════════════════

async function initOCR() {
    try {
        worker = await Tesseract.createWorker('eng', 1, { 
            logger: () => {}, 
            errorHandler: () => {} 
        });
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789.,',
            tessedit_pageseg_mode: '6'
        });
        isOCRLoaded = true;
        if (!frozen) setCamBadge('Listo para escanear', '');
        console.log("OCR Cargado");
    } catch(e) {
        console.error("Error OCR:", e);
        setCamBadge('Error cargando OCR', 'error');
    }
}

async function startCamera() {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!window.isSecureContext && !isLocal) {
        showCameraFallback('Error: En móviles debés usar HTTPS.');
        setCamBadge('Requiere HTTPS', 'error');
        return;
    }

    setCamBadge('Iniciando cámara...', 'scan');

    try {
        const constraints = {
            video: { facingMode: 'environment' },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        video.setAttribute('autoplay', '');
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            video.play().catch(e => console.log("Play forzado:", e));
            btnShutter.disabled = false;
            if (!isOCRLoaded) setCamBadge('Cargando cerebro...', 'scan');
            else setCamBadge('Listo para escanear', '');
        };

    } catch(e) {
        console.error('Cam Error:', e);
        showCameraFallback('No se pudo acceder a la cámara. Verificá los permisos.');
        setCamBadge('Sin acceso a cámara', 'error');
    }
}

function showCameraFallback(msg) {
    document.getElementById('cam-fallback-msg').textContent = msg;
    document.getElementById('cam-fallback').classList.add('visible');
}

window.retryCameraAccess = async function() {
    document.getElementById('cam-fallback').classList.remove('visible');
    await startCamera();
}

async function init() {
    startCamera(); 
    updateRates(); 
    initOCR();     
}

window.addEventListener('load', init);
