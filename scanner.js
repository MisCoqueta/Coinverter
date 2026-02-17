// ══════════════════════════════════════════════════════
//  COINVERTER — scanner.js (Versión Móvil Corregida)
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
let isOCRLoaded = false; // Nueva bandera para controlar el estado del OCR

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
//  PROCESAMIENTO DE IMAGEN
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
    // Algoritmo Otsu simplificado para rendimiento
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

function extractBestNumber(text) {
    const clean = text.replace(/[$€£¥₹]/g, '').replace(/[^\d.,\s]/g, ' ').trim();
    const matches = clean.match(/\d[\d.,]*/g);
    if (!matches) return null;
    let best = matches.reduce((a, b) => b.length > a.length ? b : a, '');
    
    // Lógica para detectar miles vs decimales
    if (/\d{1,3}(\.\d{3})+(,\d+)?$/.test(best)) best = best.replace(/\./g, '').replace(',', '.');
    else if (/\d{1,3}(,\d{3})+(\.\d+)?$/.test(best)) best = best.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(best)) best = best.replace(',', '.');
    else if (/^\d+\.\d{3}$/.test(best)) best = best.replace('.', '');
    
    const num = parseFloat(best);
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

    // IMPORTANTE MÓVIL: Usar videoWidth real, no CSS
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(video, 0, 0);
    frozenImg.src = canvas.toDataURL('image/jpeg', 0.90);
    frozenImg.style.display = 'block';

    procOverlay.classList.add('visible');
    setCamBadge('Procesando...', 'scan');

    try {
        // Recorte dinámico basado en el tamaño real del video
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
//  INICIALIZACIÓN (CÁMARA + OCR)
// ══════════════════════════════════════════════════════

async function initOCR() {
    try {
        worker = await Tesseract.createWorker('eng', 1, { 
            logger: () => {}, // Desactivar logs para rendimiento
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
    // Verificación de Seguridad para Móviles (HTTPS)
    // iOS y Android no inician la cámara sin HTTPS (excepto localhost)
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!window.isSecureContext && !isLocal) {
        showCameraFallback('Error: En móviles debés usar HTTPS.');
        setCamBadge('Requiere HTTPS', 'error');
        return;
    }

    setCamBadge('Iniciando cámara...', 'scan');

    try {
        // CORRECCIÓN MÓVIL: No pedir width/height específicos.
        // Solo pedir facingMode 'environment' (cámara trasera).
        const constraints = {
            video: { facingMode: 'environment' },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // CORRECCIÓN CRÍTICA: Forzar atributos HTML necesarios para iPhone/Safari
        video.setAttribute('autoplay', '');
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        
        video.srcObject = stream;
        
        // Esperar a que el video tenga metadata para habilitar UI
        video.onloadedmetadata = () => {
            video.play().catch(e => console.log("Play forzado:", e));
            btnShutter.disabled = false;
            // Si el OCR no cargó aún, avisar
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

// INIT: Arrancamos cámara RAPIDO, luego cargamos OCR y tasas
async function init() {
    startCamera(); // Prioridad 1: Que el usuario vea video
    updateRates(); // Prioridad 2: Datos
    initOCR();     // Prioridad 3: Procesamiento pesado
}

window.addEventListener('load', init);
