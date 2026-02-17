// ══════════════════════════════════════════════════════
//  COINVERTER — calculadora.js
// ══════════════════════════════════════════════════════

const input    = document.getElementById('manual-input');
const resVal   = document.getElementById('result-value');
const convVal  = document.getElementById('converted-value');
const fromC    = document.getElementById('from-currency');
const toC      = document.getElementById('to-currency');
const fromTag  = document.getElementById('from-tag');
const toTag    = document.getElementById('to-tag');

// ── TASAS (mismo sistema que scanner.js) ──────────────
const FALLBACK_RATES = { USD: 1, ARS: 1100, EUR: 0.92 };
let rates = { ...FALLBACK_RATES };

async function updateRates() {
    try {
        const cached   = JSON.parse(localStorage.getItem('coinverter_rates') || 'null');
        const cachedAt = parseInt(localStorage.getItem('coinverter_rates_ts') || '0');
        if (cached?.ARS && (Date.now() - cachedAt) < 3600000) {
            rates = cached; return;
        }
    } catch(e) {}

    try {
        const res  = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data?.rates?.ARS) {
            rates = { USD: 1, ARS: data.rates.ARS, EUR: data.rates.EUR };
            localStorage.setItem('coinverter_rates',    JSON.stringify(rates));
            localStorage.setItem('coinverter_rates_ts', Date.now());
            return;
        }
    } catch(e) {}

    try {
        const res  = await fetch('https://api.frankfurter.app/latest?from=USD&to=ARS,EUR');
        const data = await res.json();
        if (data?.rates?.EUR) {
            rates = { USD: 1, ARS: data.rates.ARS || 1100, EUR: data.rates.EUR };
            localStorage.setItem('coinverter_rates',    JSON.stringify(rates));
            localStorage.setItem('coinverter_rates_ts', Date.now());
        }
    } catch(e) {}
}

// ── CONVERSIÓN ────────────────────────────────────────
function convert(amount, from, to) {
    if (from === to) return amount;
    return (amount / (rates[from] || 1)) * (rates[to] || 1);
}

function formatAmount(num, currency) {
    return parseFloat(num.toFixed(2)).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

// ── INPUT ─────────────────────────────────────────────
function update() {
    const n = parseFloat(input.value);
    if (!input.value || isNaN(n)) {
        resVal.innerText  = '---';
        convVal.innerText = '---';
        return;
    }
    resVal.innerText  = formatAmount(n, fromC.value);
    convVal.innerText = formatAmount(convert(n, fromC.value, toC.value), toC.value);
}

function swapCurrencies() {
    const tmp   = fromC.value;
    fromC.value = toC.value;
    toC.value   = tmp;
    fromTag.textContent = fromC.value;
    toTag.textContent   = toC.value;
    update();
}

// ── EVENTOS ───────────────────────────────────────────
[fromC, toC].forEach(s => s.addEventListener('change', () => {
    fromTag.textContent = fromC.value;
    toTag.textContent   = toC.value;
    update();
}));

input.addEventListener('input', update);

// ── INIT ─────────────────────────────────────────────
window.addEventListener('load', updateRates);