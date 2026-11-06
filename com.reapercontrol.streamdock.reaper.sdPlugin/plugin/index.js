// ============================================================
//  ReaperControl — REAPER controller for StreamDock
//  Talks to REAPER over OSC and renders always-on VU meters.
//
//  REAPER side: an OSC control surface using ReaperControl.ReaperOSC,
//  listening on oscSendPort (8000) and sending feedback to oscRecvPort (9000).
//  See reaper/SETUP.md.
// ============================================================
const { Plugins, Actions, log } = require('./utils/plugin');
const { OscClient } = require('./utils/osc');

const plugin = new Plugins();

// ─────────────── Global defaults ───────────────
const DEFAULT_GLOBAL_SETTINGS = {
    oscHost: '127.0.0.1',
    oscSendPort: 8000,
    oscRecvPort: 9000,
    currentBank: 0,
    bankSize: 8
};

// "Control surface: Refresh all surfaces" — makes REAPER resend full state.
const REAPER_REFRESH_ACTION = 41743;
const MAX_TRACK = 64; // must match DEVICE_TRACK_COUNT in ReaperControl.ReaperOSC

// ─────────────── Runtime state ───────────────
const reaperState = {
    lastRx: 0,          // timestamp of last OSC message from REAPER (0 = never)
    tracks: {},         // trackNum (1-based, 0 = master) -> track state
    fx: {},             // trackNum -> fxNum -> { name, bypass }
    params: {},         // trackNum -> fxNum -> paramNum -> { name, value, valueStr }
    lastTouched: { name: 'Last Touched', value: 0, valueStr: '' },
    play: false,
    record: false,
    pause: false,
    repeat: false,
    click: false
};

let oscClient = null;
let oscConfigKey = '';
let oscRetryTimer = null;
let refreshTimer = null;
const activeContexts = new Map(); // context -> { action, settings, lastImage }
let renderPending = false;
let peakTimer = null;

// ─────────────── Helpers ───────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toNum = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const toBool = (v) => v === true || (typeof v === 'number' && v >= 0.5);
const isConnected = () => reaperState.lastRx > 0;

function getGlobalSettings() {
    const gs = { ...DEFAULT_GLOBAL_SETTINGS, ...(Plugins.globalSettings || {}) };
    gs.oscSendPort = Number(gs.oscSendPort) || DEFAULT_GLOBAL_SETTINGS.oscSendPort;
    gs.oscRecvPort = Number(gs.oscRecvPort) || DEFAULT_GLOBAL_SETTINGS.oscRecvPort;
    gs.currentBank = Math.max(0, Number(gs.currentBank) || 0);
    gs.bankSize = Math.max(1, Number(gs.bankSize) || DEFAULT_GLOBAL_SETTINGS.bankSize);
    return gs;
}

function getTrackNumber(settings) {
    if (settings.followBank) {
        const gs = getGlobalSettings();
        return gs.currentBank * gs.bankSize + (Number(settings.bankOffset) || 1);
    }
    return Number(settings.trackNumber) || 1;
}

function ensureTrack(n) {
    if (!reaperState.tracks[n]) {
        reaperState.tracks[n] = {
            name: n === 0 ? 'MASTER' : `Track ${n}`,
            volumeNorm: 0.716, // ~0 dB on REAPER's fader curve
            volumeDb: 0,
            pan: 0.5,
            mute: false,
            solo: false,
            recarm: false,
            select: false,
            vu: 0,
            vuL: 0,
            vuR: 0,
            peak: 0,
            peakTime: 0
        };
    }
    return reaperState.tracks[n];
}

function ensureFx(t, f) {
    reaperState.fx[t] ??= {};
    reaperState.fx[t][f] ??= { name: `FX ${f}`, bypass: false };
    return reaperState.fx[t][f];
}

function ensureParam(t, f, p) {
    reaperState.params[t] ??= {};
    reaperState.params[t][f] ??= {};
    reaperState.params[t][f][p] ??= { name: `Param ${p}`, value: 0, valueStr: '' };
    return reaperState.params[t][f][p];
}

function escapeXml(str) {
    return String(str).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function truncate(str, len) {
    str = String(str ?? '');
    return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

// ─────────────── OSC lifecycle ───────────────
function ensureOsc() {
    const gs = getGlobalSettings();
    const key = `${gs.oscHost}|${gs.oscSendPort}|${gs.oscRecvPort}`;
    if (oscClient && key === oscConfigKey) return;
    openOsc(gs, key);
}

function openOsc(gs, key) {
    clearTimeout(oscRetryTimer);
    if (oscClient) oscClient.close();
    oscConfigKey = key;
    reaperState.lastRx = 0;

    const client = new OscClient({
        host: gs.oscHost,
        sendPort: gs.oscSendPort,
        recvPort: gs.oscRecvPort,
        onMessage: handleOscMessage,
        onError: (err) => {
            log.error('OSC error:', err && err.message ? err.message : err);
            if (err && err.code === 'EADDRINUSE') {
                // Another process (often a previous plugin instance) owns the port. Retry.
                log.error(`UDP port ${gs.oscRecvPort} is in use — retrying in 5 s`);
                client.close();
                if (oscClient === client) {
                    oscRetryTimer = setTimeout(() => {
                        if (oscClient === client) openOsc(getGlobalSettings(), oscConfigKey);
                    }, 5000);
                }
            }
        },
        onReady: () => {
            log.info(`OSC listening on ${gs.oscRecvPort}, sending to ${gs.oscHost}:${gs.oscSendPort}`);
            requestRefresh();
        }
    });
    oscClient = client;
    client.open();
    startRefreshLoop();
    scheduleRender();
}

function sendOsc(address, args = []) {
    ensureOsc();
    try {
        oscClient.send(address, args);
    } catch (e) {
        log.error('sendOsc failed:', e);
    }
}

function requestRefresh() {
    sendOsc(`/action/${REAPER_REFRESH_ACTION}`);
}

// Until REAPER answers, ask for a full refresh every few seconds so the plugin
// picks up state as soon as REAPER is started (in any order).
function startRefreshLoop() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
        if (!oscClient || activeContexts.size === 0) return;
        if (!isConnected()) requestRefresh();
    }, 3000);
}

let rxLogCount = 0;
function handleOscMessage(address, args) {
    const parts = address.split('/').filter(Boolean);
    if (!parts.length) return;
    const head = parts[0];
    const known = ['track', 'master', 'fxparam', 'fx', 'play', 'stop', 'pause', 'record', 'repeat', 'click'];
    if (!known.includes(head)) return; // not REAPER / not our pattern — ignore

    if (!isConnected()) log.info('First message from REAPER received:', address, args);
    reaperState.lastRx = Date.now();
    if (++rxLogCount <= 10) log.info('OSC rx:', address, args);

    const val = args[0];

    if (head === 'track' && parts.length >= 3) {
        const t = parseInt(parts[1], 10);
        if (!Number.isInteger(t)) return; // e.g. /track/vu for the device-selected track
        const rest = parts.slice(2);
        if (rest[0] === 'fx' && rest.length >= 3) {
            handleFxMessage(t, rest.slice(1), val);
        } else {
            updateTrack(ensureTrack(t), rest.join('/'), val);
        }
        scheduleRender();
        return;
    }

    if (head === 'master' && parts.length >= 2) {
        updateTrack(ensureTrack(0), parts.slice(1).join('/'), val);
        scheduleRender();
        return;
    }

    if (head === 'fxparam' && parts[1] === 'last_touched') {
        const lt = reaperState.lastTouched;
        const prop = parts.slice(2).join('/');
        if (prop === 'value') lt.value = toNum(val, lt.value);
        else if (prop === 'value/str') lt.valueStr = String(val ?? '');
        else if (prop === 'name') lt.name = String(val ?? lt.name);
        scheduleRender();
        return;
    }

    switch (head) {
        case 'play': reaperState.play = toBool(val); break;
        case 'stop': if (toBool(val)) { reaperState.play = false; reaperState.pause = false; } break;
        case 'pause': reaperState.pause = toBool(val); break;
        case 'record': reaperState.record = toBool(val); break;
        case 'repeat': reaperState.repeat = toBool(val); break;
        case 'click': reaperState.click = toBool(val); break;
        default: return;
    }
    scheduleRender();
}

// rest = [fxNum, ...]  e.g. ['2','name'] or ['2','fxparam','4','value']
function handleFxMessage(t, rest, val) {
    const f = parseInt(rest[0], 10);
    if (!Number.isInteger(f)) return;
    if (rest[1] === 'fxparam' && rest.length >= 4) {
        const p = parseInt(rest[2], 10);
        if (!Number.isInteger(p)) return;
        const param = ensureParam(t, f, p);
        const prop = rest.slice(3).join('/');
        if (prop === 'value') param.value = toNum(val, param.value);
        else if (prop === 'value/str') param.valueStr = String(val ?? '');
        else if (prop === 'name') param.name = String(val ?? param.name);
        return;
    }
    const fx = ensureFx(t, f);
    const prop = rest.slice(1).join('/');
    if (prop === 'name') fx.name = String(val ?? fx.name);
    else if (prop === 'bypass') fx.bypass = toBool(val);
}

function updateTrack(track, prop, val) {
    switch (prop) {
        case 'vu': track.vu = toNum(val, 0); break;
        case 'vu/L': track.vuL = toNum(val, 0); break;
        case 'vu/R': track.vuR = toNum(val, 0); break;
        case 'volume': track.volumeNorm = toNum(val, track.volumeNorm); break;
        case 'volume/db': track.volumeDb = toNum(val, track.volumeDb); break;
        case 'pan': track.pan = toNum(val, track.pan); break;
        case 'mute': track.mute = toBool(val); break;
        case 'solo': track.solo = toBool(val); break;
        case 'recarm': track.recarm = toBool(val); break;
        case 'select': track.select = toBool(val); break;
        case 'name': if (typeof val === 'string' && val) track.name = val; break;
        default: return;
    }
    if (prop.startsWith('vu')) {
        const level = Math.max(track.vu, track.vuL, track.vuR);
        if (level >= track.peak) {
            track.peak = level;
            track.peakTime = Date.now();
        }
    }
}

// ─────────────── Rendering ───────────────
function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
        renderPending = false;
        renderAll();
    }, 33);
}

const RENDERERS = {
    channelstrip: (s) => buildChannelStripSvg(ensureTrack(getTrackNumber(s)), s),
    channelfader: (s) => buildChannelFaderSvg(ensureTrack(getTrackNumber(s)), s),
    transport: (s) => buildTransportSvg(s),
    bank: (s) => buildBankSvg(s),
    fxparam: (s) => buildFxParamSvg(getFxParamState(s), s)
};

function renderContext(context) {
    const info = activeContexts.get(context);
    if (!info) return;
    try {
        const image = svgDataUrl(RENDERERS[info.action](info.settings));
        if (image !== info.lastImage) {
            info.lastImage = image;
            plugin.setImage(context, image);
        }
    } catch (e) {
        log.error('render error:', e);
    }
}

function renderAll() {
    for (const context of activeContexts.keys()) renderContext(context);
}

function svgDataUrl(svg) {
    return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function svgWrap(bg, body) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
        `<rect width="144" height="144" fill="${bg}"/>${body}</svg>`;
}

// Small "waiting for REAPER" banner shown until the first OSC message arrives.
function offlineBadge() {
    if (isConnected()) return '';
    return '<rect x="0" y="126" width="144" height="18" fill="#552200"/>' +
        '<text x="72" y="139" font-family="Arial" font-size="11" font-weight="bold" fill="#ffbb66" text-anchor="middle">NO REAPER</text>';
}

function vuColor(level) {
    if (level > 0.9) return '#ff3333';
    if (level > 0.7) return '#ffcc00';
    return '#00ff66';
}

function badge(x, y, w, fill, textFill, label) {
    return `<rect x="${x}" y="${y}" width="${w}" height="16" fill="${fill}" rx="2"/>` +
        `<text x="${x + w / 2}" y="${y + 12}" font-family="Arial" font-size="10" font-weight="bold" fill="${textFill}" text-anchor="middle">${label}</text>`;
}

function buildChannelStripSvg(track, settings) {
    const trackNum = getTrackNumber(settings);
    let bg = '#16162a';
    if (track.mute) bg = '#4a1111';
    else if (track.solo) bg = '#4a4511';
    else if (track.recarm) bg = '#4a1133';

    const meterTop = 26, meterBottom = 136, meterH = meterBottom - meterTop;
    const meter = (x, w, level) => {
        level = clamp(level, 0, 1);
        const h = Math.round(level * meterH);
        return `<rect x="${x}" y="${meterTop}" width="${w}" height="${meterH}" fill="#0b0b16" stroke="#555555" stroke-width="1"/>` +
            (h > 0 ? `<rect x="${x}" y="${meterBottom - h}" width="${w}" height="${h}" fill="${vuColor(level)}"/>` : '');
    };
    const stereo = track.vuL > 0 || track.vuR > 0;
    let meters = stereo ? meter(108, 15, track.vuL) + meter(125, 15, track.vuR) : meter(108, 32, track.vu);
    if (settings.showPeak !== false && track.peak > 0.001) {
        const py = meterBottom - Math.round(clamp(track.peak, 0, 1) * meterH);
        meters += `<rect x="108" y="${py}" width="32" height="2" fill="${track.peak > 0.95 ? '#ff0000' : '#ffffff'}"/>`;
    }

    const labelSize = clamp(Number(settings.labelSize) || 13, 8, 24);
    const name = escapeXml(truncate(track.name, 12));
    const dbText = `${track.volumeDb > 0 ? '+' : ''}${track.volumeDb.toFixed(1)} dB`;

    let badges = '';
    if (track.mute) badges += badge(4, 84, 46, '#ff2222', '#ffffff', 'MUTE');
    if (track.solo) badges += badge(54, 84, 46, '#ffcc00', '#000000', 'SOLO');
    if (track.recarm) badges += badge(4, 104, 46, '#ff0066', '#ffffff', 'REC');
    if (track.select) badges += badge(54, 104, 46, '#3388ff', '#ffffff', 'SEL');

    return svgWrap(bg,
        `<text x="4" y="18" font-family="Arial" font-size="${labelSize}" font-weight="bold" fill="#eeeeee">${name}</text>` +
        `<text x="4" y="44" font-family="Arial" font-size="11" fill="#888888">${trackNum === 0 ? 'MASTER' : 'TRK ' + trackNum}</text>` +
        `<text x="4" y="64" font-family="Arial" font-size="13" font-weight="bold" fill="#cccccc">${dbText}</text>` +
        badges + meters + offlineBadge());
}

function buildChannelFaderSvg(track, settings) {
    const isPan = settings.knobAction === 'pan';
    const color = isPan ? '#33ccff' : '#00ff66';
    let bar, valueText;
    if (isPan) {
        const pan = clamp(track.pan, 0, 1);
        const center = 72, x = 18 + pan * 108;
        const left = Math.min(center, x), width = Math.max(2, Math.abs(x - center));
        bar = `<rect x="${left}" y="80" width="${width}" height="18" fill="${color}"/>` +
            `<rect x="71" y="76" width="2" height="26" fill="#ffffff"/>`;
        const pct = Math.round((pan - 0.5) * 200);
        valueText = pct === 0 ? 'C' : pct < 0 ? `${-pct}% L` : `${pct}% R`;
    } else {
        const w = Math.round(clamp(track.volumeNorm, 0, 1) * 108);
        bar = w > 0 ? `<rect x="18" y="80" width="${w}" height="18" fill="${color}" rx="3"/>` : '';
        valueText = `${track.volumeDb > 0 ? '+' : ''}${track.volumeDb.toFixed(1)} dB`;
    }
    const bg = track.mute ? '#4a1111' : '#16162a';
    return svgWrap(bg,
        `<text x="72" y="22" font-family="Arial" font-size="12" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${isPan ? 'PAN' : 'VOL'}${track.mute ? ' · MUTED' : ''}</text>` +
        `<text x="72" y="48" font-family="Arial" font-size="14" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(truncate(track.name, 14))}</text>` +
        `<rect x="18" y="80" width="108" height="18" fill="#333333" rx="3"/>` + bar +
        `<text x="72" y="122" font-family="Arial" font-size="17" font-weight="bold" fill="#ffffff" text-anchor="middle">${valueText}</text>` +
        offlineBadge());
}

// Transport icons drawn as shapes (unicode glyphs don't render reliably in SVG Tiny).
function transportIcon(cmd, color) {
    switch (cmd) {
        case 'play': return `<polygon points="54,30 54,90 102,60" fill="${color}"/>`;
        case 'stop': return `<rect x="46" y="34" width="52" height="52" fill="${color}"/>`;
        case 'pause': return `<rect x="46" y="32" width="18" height="56" fill="${color}"/><rect x="80" y="32" width="18" height="56" fill="${color}"/>`;
        case 'record': return `<circle cx="72" cy="60" r="28" fill="${color}"/>`;
        case 'click': return `<polygon points="56,90 88,90 80,30 64,30" fill="none" stroke="${color}" stroke-width="5"/>` +
            `<line x1="72" y1="80" x2="90" y2="40" stroke="${color}" stroke-width="5"/>`;
        case 'repeat': return `<path d="M46 52 A26 26 0 0 1 96 50" fill="none" stroke="${color}" stroke-width="7"/>` +
            `<polygon points="88,40 106,50 90,62" fill="${color}"/>` +
            `<path d="M98 68 A26 26 0 0 1 48 70" fill="none" stroke="${color}" stroke-width="7"/>` +
            `<polygon points="56,82 38,72 54,60" fill="${color}"/>`;
        default: return '';
    }
}

function buildTransportSvg(settings) {
    const cmd = settings.command || 'play';
    const active = {
        play: reaperState.play && !reaperState.pause,
        stop: !reaperState.play && !reaperState.record,
        pause: reaperState.pause,
        record: reaperState.record,
        click: reaperState.click,
        repeat: reaperState.repeat
    }[cmd];
    const activeColor = cmd === 'record' ? '#ff3333' : '#00ff66';
    const bg = active && cmd !== 'stop' ? (cmd === 'record' ? '#441111' : '#114411') : '#1a1a2e';
    const label = { play: 'PLAY', stop: 'STOP', pause: 'PAUSE', record: 'REC', click: 'CLICK', repeat: 'LOOP' }[cmd] || cmd.toUpperCase();
    return svgWrap(bg,
        transportIcon(cmd, active ? activeColor : '#ffffff') +
        `<text x="72" y="118" font-family="Arial" font-size="15" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${label}</text>` +
        offlineBadge());
}

function buildBankSvg(settings) {
    const gs = getGlobalSettings();
    const next = (settings.direction || 'next') === 'next';
    const arrows = next
        ? '<polygon points="34,30 34,70 66,50" fill="#ffffff"/><polygon points="70,30 70,70 102,50" fill="#ffffff"/>'
        : '<polygon points="110,30 110,70 78,50" fill="#ffffff"/><polygon points="74,30 74,70 42,50" fill="#ffffff"/>';
    const first = gs.currentBank * gs.bankSize + 1;
    return svgWrap('#1a1a2e',
        arrows +
        `<text x="72" y="96" font-family="Arial" font-size="14" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${next ? 'BANK +' : 'BANK -'}</text>` +
        `<text x="72" y="118" font-family="Arial" font-size="13" fill="#888888" text-anchor="middle">Tracks ${first}-${first + gs.bankSize - 1}</text>`);
}

function fxTarget(settings) {
    return {
        t: Number(settings.trackNumber) || 1,
        f: Number(settings.fxNumber) || 1,
        p: Number(settings.paramNumber) || 1
    };
}

function getFxParamState(settings) {
    if (settings.lastTouched) {
        return { ...reaperState.lastTouched, fxName: 'LAST TOUCHED', bypass: false };
    }
    const { t, f, p } = fxTarget(settings);
    const fx = ensureFx(t, f);
    return { ...ensureParam(t, f, p), fxName: fx.name, bypass: fx.bypass };
}

function buildFxParamSvg(state) {
    const value = clamp(state.value, 0, 1);
    const bg = state.bypass ? '#332211' : '#1a1a2e';
    const color = state.bypass ? '#888888' : '#33ccff';
    const w = Math.round(value * 108);
    const valueText = state.valueStr ? truncate(state.valueStr, 12) : `${Math.round(value * 100)}%`;
    return svgWrap(bg,
        `<text x="72" y="18" font-family="Arial" font-size="10" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${escapeXml(truncate(state.fxName, 22))}</text>` +
        `<text x="72" y="46" font-family="Arial" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(truncate(state.name, 18))}</text>` +
        `<rect x="18" y="66" width="108" height="20" fill="#333333" rx="3"/>` +
        (w > 0 ? `<rect x="18" y="66" width="${w}" height="20" fill="${color}" rx="3"/>` : '') +
        `<text x="72" y="112" font-family="Arial" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(valueText)}</text>` +
        (state.bypass ? '<text x="72" y="130" font-family="Arial" font-size="11" fill="#ff9900" text-anchor="middle">BYPASSED</text>' : '') +
        offlineBadge());
}

// ─────────────── Peak-hold decay ───────────────
function startPeakTimer() {
    if (peakTimer) return;
    peakTimer = setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const t of Object.values(reaperState.tracks)) {
            if (t.peak > 0 && now - t.peakTime > 900) {
                t.peak = Math.max(0, t.peak - 0.03);
                changed = true;
            }
        }
        if (changed) scheduleRender();
    }, 50);
}

// ─────────────── Plugin-level events ───────────────
plugin.didReceiveGlobalSettings = ({ payload }) => {
    Plugins.globalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...(payload?.settings || {}) };
    if (activeContexts.size) ensureOsc(); // re-opens the socket only if host/ports changed
    scheduleRender();
};

plugin.systemDidWakeUp = () => {
    reaperState.lastRx = 0;
    if (oscClient) requestRefresh();
};

// ─────────────── Shared action plumbing ───────────────
function makeAction(name, def, handlers) {
    return new Actions({
        default: def,
        _willAppear({ context, payload }) {
            const settings = { ...def, ...(payload?.settings || {}) };
            activeContexts.set(context, { action: name, settings, lastImage: null });
            plugin.setTitle(context, '');
            ensureOsc();
            startPeakTimer();
            renderContext(context);
            if (isConnected()) requestRefresh();
        },
        _willDisappear({ context }) {
            activeContexts.delete(context);
        },
        _didReceiveSettings({ context }) {
            const info = activeContexts.get(context);
            if (!info) return;
            info.settings = { ...def, ...this.data[context] };
            renderContext(context);
        },
        ...handlers
    });
}

const settingsOf = (context, def) => activeContexts.get(context)?.settings || def;

// ─────────────── Action: channelstrip ───────────────
const CHANNELSTRIP_DEFAULT = {
    trackNumber: 1, followBank: false, bankOffset: 1, pressAction: 'mute', showPeak: true, labelSize: 13
};
plugin.channelstrip = makeAction('channelstrip', CHANNELSTRIP_DEFAULT, {
    keyUp({ context }) {
        const s = settingsOf(context, CHANNELSTRIP_DEFAULT);
        const t = getTrackNumber(s);
        switch (s.pressAction || 'mute') {
            case 'mute': sendOsc(`/track/${t}/mute/toggle`); break;
            case 'solo': sendOsc(`/track/${t}/solo/toggle`); break;
            case 'recarm': sendOsc(`/track/${t}/recarm/toggle`); break;
            case 'select': sendOsc(`/track/${t}/select`, [1]); break;
        }
    }
});

// ─────────────── Action: channelfader (Knob) ───────────────
const CHANNELFADER_DEFAULT = {
    trackNumber: 1, followBank: false, bankOffset: 1, knobAction: 'volume', sensitivity: 1.0
};
plugin.channelfader = makeAction('channelfader', CHANNELFADER_DEFAULT, {
    dialRotate({ context, payload }) {
        const s = settingsOf(context, CHANNELFADER_DEFAULT);
        const t = getTrackNumber(s);
        const track = ensureTrack(t);
        const ticks = Number(payload?.ticks) || 0;
        const sens = Number(s.sensitivity) || 1.0;
        if (s.knobAction === 'pan') {
            track.pan = clamp(track.pan + ticks * 0.02 * sens, 0, 1);
            sendOsc(`/track/${t}/pan`, [track.pan]);
        } else {
            // Below -60 dB REAPER's curve gets steep — jump faster there.
            const step = track.volumeDb < -60 ? 3 : 0.5;
            track.volumeDb = clamp(track.volumeDb + ticks * step * sens, -150, 12);
            sendOsc(`/track/${t}/volume/db`, [track.volumeDb]);
        }
        renderContext(context);
    },
    dialDown({ context }) {
        const t = getTrackNumber(settingsOf(context, CHANNELFADER_DEFAULT));
        sendOsc(`/track/${t}/mute/toggle`);
    }
});

// ─────────────── Action: transport ───────────────
const TRANSPORT_DEFAULT = { command: 'play' };
plugin.transport = makeAction('transport', TRANSPORT_DEFAULT, {
    keyUp({ context }) {
        const cmd = settingsOf(context, TRANSPORT_DEFAULT).command || 'play';
        if (cmd === 'play') sendOsc(reaperState.play && !reaperState.pause ? '/stop' : '/play');
        else if (['stop', 'pause', 'record', 'click', 'repeat'].includes(cmd)) sendOsc(`/${cmd}`);
    }
});

// ─────────────── Action: bank ───────────────
const BANK_DEFAULT = { direction: 'next', bankSize: 8 };
plugin.bank = makeAction('bank', BANK_DEFAULT, {
    keyUp({ context }) {
        const s = settingsOf(context, BANK_DEFAULT);
        const gs = getGlobalSettings();
        const size = Math.max(1, Number(s.bankSize) || gs.bankSize);
        const maxBank = Math.max(0, Math.ceil(MAX_TRACK / size) - 1);
        const bank = s.direction === 'next' ? Math.min(maxBank, gs.currentBank + 1) : Math.max(0, gs.currentBank - 1);
        plugin.setGlobalSettings({ ...gs, currentBank: bank, bankSize: size });
        scheduleRender();
    }
});

// ─────────────── Action: fxparam ───────────────
const FXPARAM_DEFAULT = {
    trackNumber: 1, fxNumber: 1, paramNumber: 1, lastTouched: false, pressAction: 'bypass', sensitivity: 1.0
};
function fxPress(context) {
    const s = settingsOf(context, FXPARAM_DEFAULT);
    if (s.lastTouched) return;
    const { t, f } = fxTarget(s);
    if ((s.pressAction || 'bypass') === 'bypass') {
        const fx = ensureFx(t, f);
        fx.bypass = !fx.bypass;
        sendOsc(`/track/${t}/fx/${f}/bypass`, [fx.bypass ? 1 : 0]);
        renderContext(context);
    } else {
        sendOsc(`/track/${t}/fx/${f}/openui`, [1]);
    }
}
plugin.fxparam = makeAction('fxparam', FXPARAM_DEFAULT, {
    keyUp({ context }) { fxPress(context); },
    dialDown({ context }) { fxPress(context); },
    dialRotate({ context, payload }) {
        const s = settingsOf(context, FXPARAM_DEFAULT);
        if (s.lastTouched) return; // REAPER's OSC has no "set last touched param" message
        const { t, f, p } = fxTarget(s);
        const param = ensureParam(t, f, p);
        const delta = (Number(payload?.ticks) || 0) * 0.01 * (Number(s.sensitivity) || 1.0);
        param.value = clamp(param.value + delta, 0, 1);
        param.valueStr = '';
        sendOsc(`/track/${t}/fx/${f}/fxparam/${p}/value`, [param.value]);
        renderContext(context);
    }
});

log.info('ReaperControl plugin backend started');
