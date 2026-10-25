// ============================================================
//  ReaperControl — REAPER controller for StreamDock
//  Talks to REAPER over OSC and renders always-on VU meters.
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

// ─────────────── Runtime state ───────────────
const reaperState = {
    connected: false,
    tracks: {},        // trackNum (1-based) -> state object
    fx: {},            // trackNum -> fxNum -> paramNum -> { name, value, fxName, bypass }
    lastTouched: { name: 'Last Touched', value: 0 },
    play: false,
    record: false,
    pause: false,
    repeat: false,
    click: false
};

let oscClient = null;
const activeContexts = new Map(); // context -> { action, settings }
let renderPending = false;
let renderInterval = null;

// ─────────────── Helpers ───────────────
function getGlobalSettings() {
    return { ...DEFAULT_GLOBAL_SETTINGS, ...Plugins.globalSettings };
}

function getTrackNumber(settings) {
    const gs = getGlobalSettings();
    if (settings.followBank) {
        return gs.currentBank * gs.bankSize + (settings.bankOffset || 1);
    }
    return settings.trackNumber || 1;
}

function ensureTrack(trackNum) {
    if (!reaperState.tracks[trackNum]) {
        reaperState.tracks[trackNum] = {
            name: `Track ${trackNum}`,
            volumeDb: 0,
            volumeNorm: 0.75,
            mute: false,
            solo: false,
            recarm: false,
            vu: 0,
            vuL: 0,
            vuR: 0,
            peak: 0,
            peakTime: 0
        };
    }
    return reaperState.tracks[trackNum];
}

function ensureFx(trackNum, fxNum, paramNum) {
    if (!reaperState.fx[trackNum]) reaperState.fx[trackNum] = {};
    if (!reaperState.fx[trackNum][fxNum]) reaperState.fx[trackNum][fxNum] = {};
    if (!reaperState.fx[trackNum][fxNum][paramNum]) {
        reaperState.fx[trackNum][fxNum][paramNum] = {
            name: `Param ${paramNum}`,
            value: 0,
            fxName: `FX ${fxNum}`,
            bypass: false
        };
    }
    return reaperState.fx[trackNum][fxNum][paramNum];
}

function escapeXml(str) {
    return String(str).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function truncate(str, len) {
    str = String(str || '');
    return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

// ─────────────── OSC lifecycle ───────────────
function initOsc() {
    if (oscClient) {
        try { oscClient.close(); } catch (e) { log.error(e); }
    }
    const gs = getGlobalSettings();
    oscClient = new OscClient({
        host: gs.oscHost,
        sendPort: gs.oscSendPort,
        recvPort: gs.oscRecvPort,
        onMessage: handleOscMessage,
        onError: (err) => {
            reaperState.connected = false;
            log.error('OSC error:', err);
        }
    });
    oscClient.open();
    reaperState.connected = true;
    log.info(`OSC opened: send to ${gs.oscHost}:${gs.oscSendPort}, listen on ${gs.oscRecvPort}`);
}

function sendOsc(address, args) {
    if (!oscClient) initOsc();
    try {
        oscClient.send(address, args);
    } catch (e) {
        log.error('sendOsc failed:', e);
    }
}

function handleOscMessage(address, args) {
    reaperState.connected = true;
    const parts = address.split('/').filter(Boolean);
    if (!parts.length) return;

    const head = parts[0];

    if (head === 'track' && parts.length >= 2) {
        const trackNum = parseInt(parts[1], 10);
        if (isNaN(trackNum)) return;
        const rest = parts.slice(2);

        // FX messages: /track/3/fx/1/fxparam/4/value
        if (rest.length >= 4 && rest[0] === 'fx') {
            const fxNum = parseInt(rest[1], 10);
            const fxRest = rest.slice(2);
            if (fxRest.length >= 3 && fxRest[0] === 'fxparam') {
                const paramNum = parseInt(fxRest[1], 10);
                const prop = fxRest[2];
                const p = ensureFx(trackNum, fxNum, paramNum);
                const val = args[0];
                if (prop === 'value') p.value = typeof val === 'number' ? val : 0;
                else if (prop === 'name') p.name = typeof val === 'string' ? val : p.name;
                scheduleRender();
                return;
            }
            // FX-level: /track/3/fx/1/name or /bypass
            const fxProp = fxRest.join('/');
            const fx = ensureFx(trackNum, fxNum, 1);
            const val = args[0];
            if (fxProp === 'name') fx.fxName = typeof val === 'string' ? val : fx.fxName;
            else if (fxProp === 'bypass') fx.bypass = val === 1 || val === true;
            scheduleRender();
            return;
        }

        const prop = rest.join('/');
        updateTrack(ensureTrack(trackNum), prop, args);
        scheduleRender();
        return;
    }

    if (head === 'master' && parts.length >= 2) {
        const prop = parts.slice(1).join('/');
        updateTrack(ensureTrack(0), prop, args);
        scheduleRender();
        return;
    }

    if (head === 'fxparam' && parts.length >= 2) {
        const val = args[0];
        if (parts[1] === 'last_touched') {
            if (parts[2] === 'value') reaperState.lastTouched.value = typeof val === 'number' ? val : 0;
            else if (parts[2] === 'name') reaperState.lastTouched.name = typeof val === 'string' ? val : reaperState.lastTouched.name;
            scheduleRender();
        }
        return;
    }

    switch (head) {
        case 'play': reaperState.play = args[0] !== 0 && args[0] !== false; break;
        case 'stop': reaperState.play = false; break;
        case 'pause': reaperState.pause = args[0] !== 0 && args[0] !== false; break;
        case 'record': reaperState.record = args[0] !== 0 && args[0] !== false; break;
        case 'repeat': reaperState.repeat = args[0] !== 0 && args[0] !== false; break;
        case 'click': reaperState.click = args[0] !== 0 && args[0] !== false; break;
    }
    scheduleRender();
}

function updateTrack(track, prop, args) {
    const val = args[0];
    switch (prop) {
        case 'vu': track.vu = typeof val === 'number' ? val : 0; break;
        case 'vu/L': track.vuL = typeof val === 'number' ? val : 0; break;
        case 'vu/R': track.vuR = typeof val === 'number' ? val : 0; break;
        case 'volume': track.volumeNorm = typeof val === 'number' ? val : track.volumeNorm; break;
        case 'volume/db': track.volumeDb = typeof val === 'number' ? val : track.volumeDb; break;
        case 'mute': track.mute = val === 1 || val === true; break;
        case 'solo': track.solo = val === 1 || val === true; break;
        case 'recarm': track.recarm = val === 1 || val === true; break;
        case 'name': track.name = typeof val === 'string' ? val : track.name; break;
    }
    const maxVu = Math.max(track.vu, track.vuL, track.vuR);
    if (maxVu >= track.peak) {
        track.peak = maxVu;
        track.peakTime = Date.now();
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

function renderAll() {
    for (const [context, info] of activeContexts) {
        try {
            if (info.action === 'channelstrip') renderChannelStrip(context, info.settings);
            else if (info.action === 'channelfader') renderChannelFader(context, info.settings);
            else if (info.action === 'transport') renderTransport(context, info.settings);
            else if (info.action === 'bank') renderBank(context, info.settings);
            else if (info.action === 'fxparam') renderFxParam(context, info.settings);
        } catch (e) {
            log.error('render error:', e);
        }
    }
}

function vuColor(level) {
    if (level > 0.9) return '#ff3333';
    if (level > 0.7) return '#ffcc00';
    return '#00ff66';
}

function dbFromNorm(norm) {
    if (norm <= 0.00001) return '-inf';
    const db = 20 * Math.log10(norm);
    return db > 0 ? `+${db.toFixed(1)}` : `${db.toFixed(1)}`;
}

function svgDataUrl(svg) {
    return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function buildChannelStripSvg(track, settings) {
    const w = 144, h = 144;
    const level = Math.max(0, Math.min(1, track.vu));
    const peak = Math.max(0, Math.min(1, track.peak));
    let bg = '#16162a';
    if (track.mute) bg = '#4a1111';
    else if (track.solo) bg = '#5a5511';
    else if (track.recarm) bg = '#4a1133';

    const meterTop = 24;
    const meterBottom = h - 8;
    const meterH = meterBottom - meterTop;
    const barH = Math.round(level * meterH);
    const peakY = meterBottom - Math.round(peak * meterH);
    const color = vuColor(level);
    const peakColor = peak > 0.95 ? '#ff0000' : '#ffffff';
    const labelSize = settings.labelSize || 13;

    return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <rect width="${w}" height="${h}" fill="${bg}"/>
        <text x="4" y="18" font-family="Arial" font-size="${labelSize}" font-weight="bold" fill="#eeeeee">${escapeXml(truncate(track.name, 14))}</text>
        <rect x="114" y="${meterBottom - barH}" width="26" height="${barH}" fill="${color}"/>
        <rect x="114" y="${peakY}" width="26" height="2" fill="${peakColor}"/>
        <rect x="114" y="${meterTop}" width="26" height="${meterH}" fill="none" stroke="#555555" stroke-width="1"/>
        <text x="108" y="20" font-family="Arial" font-size="9" fill="#aaaaaa" text-anchor="end">${dbFromNorm(level)}</text>
        ${track.mute ? '<rect x="4" y="96" width="38" height="16" fill="#ff0000" rx="2"/><text x="7" y="108" font-family="Arial" font-size="10" font-weight="bold" fill="#ffffff">MUTE</text>' : ''}
        ${track.solo ? '<rect x="46" y="96" width="34" height="16" fill="#ffcc00" rx="2"/><text x="49" y="108" font-family="Arial" font-size="10" font-weight="bold" fill="#000000">SOLO</text>' : ''}
        ${track.recarm ? '<rect x="4" y="116" width="38" height="16" fill="#ff0066" rx="2"/><text x="7" y="128" font-family="Arial" font-size="10" font-weight="bold" fill="#ffffff">REC</text>' : ''}
    </svg>`);
}

function renderChannelStrip(context, settings) {
    const trackNum = getTrackNumber(settings);
    const track = ensureTrack(trackNum);
    plugin.setImage(context, buildChannelStripSvg(track, settings));
    plugin.setTitle(context, '');
}

function buildChannelFaderSvg(track, settings) {
    const w = 144, h = 144;
    const level = Math.max(0, Math.min(1, track.volumeNorm));
    const bg = '#16162a';
    const color = settings.knobAction === 'pan' ? '#33ccff' : '#00ff66';
    const label = settings.knobAction === 'pan' ? 'PAN' : 'VOL';
    const valueText = settings.knobAction === 'pan'
        ? `${(track.volumeNorm * 2 - 1).toFixed(2)}`
        : `${track.volumeDb.toFixed(1)} dB`;

    return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <rect width="${w}" height="${h}" fill="${bg}"/>
        <text x="72" y="22" font-family="Arial" font-size="12" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${label}</text>
        <text x="72" y="46" font-family="Arial" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(truncate(track.name, 16))}</text>
        <rect x="18" y="80" width="108" height="18" fill="#333333" rx="3"/>
        <rect x="18" y="80" width="${Math.round(level * 108)}" height="18" fill="${color}" rx="3"/>
        <text x="72" y="122" font-family="Arial" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle">${valueText}</text>
    </svg>`);
}

function renderChannelFader(context, settings) {
    const trackNum = getTrackNumber(settings);
    const track = ensureTrack(trackNum);
    plugin.setImage(context, buildChannelFaderSvg(track, settings));
    plugin.setTitle(context, '');
}

function renderTransport(context, settings) {
    const cmd = settings.command || 'play';
    const active = (cmd === 'play' && reaperState.play) ||
                   (cmd === 'record' && reaperState.record) ||
                   (cmd === 'click' && reaperState.click) ||
                   (cmd === 'repeat' && reaperState.repeat);
    const bg = active ? '#114411' : '#1a1a2e';
    const iconColor = active ? '#00ff66' : '#ffffff';
    let icon = '';
    if (cmd === 'play') icon = '▶';
    else if (cmd === 'stop') icon = '■';
    else if (cmd === 'record') icon = '●';
    else if (cmd === 'pause') icon = '❚❚';
    else if (cmd === 'click') icon = '♪';
    else if (cmd === 'repeat') icon = '↻';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
        <rect width="144" height="144" fill="${bg}"/>
        <text x="72" y="92" font-family="Arial" font-size="64" fill="${iconColor}" text-anchor="middle">${icon}</text>
        <text x="72" y="122" font-family="Arial" font-size="14" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${cmd.toUpperCase()}</text>
    </svg>`;
    plugin.setImage(context, svgDataUrl(svg));
    plugin.setTitle(context, '');
}

function renderBank(context, settings) {
    const gs = getGlobalSettings();
    const dir = settings.direction || 'next';
    const bg = '#1a1a2e';
    const arrow = dir === 'next' ? '▶▶' : '◀◀';
    const label = dir === 'next' ? 'BANK +' : 'BANK -';
    const range = `${gs.currentBank * gs.bankSize + 1}-${(gs.currentBank + 1) * gs.bankSize}`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
        <rect width="144" height="144" fill="${bg}"/>
        <text x="72" y="64" font-family="Arial" font-size="48" fill="#ffffff" text-anchor="middle">${arrow}</text>
        <text x="72" y="96" font-family="Arial" font-size="14" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${label}</text>
        <text x="72" y="120" font-family="Arial" font-size="12" fill="#888888" text-anchor="middle">${range}</text>
    </svg>`;
    plugin.setImage(context, svgDataUrl(svg));
    plugin.setTitle(context, '');
}

function getFxParamState(settings) {
    if (settings.lastTouched) {
        return { ...reaperState.lastTouched, fxName: 'Last Touched', bypass: false };
    }
    const trackNum = settings.trackNumber || 1;
    const fxNum = settings.fxNumber || 1;
    const paramNum = settings.paramNumber || 1;
    const state = ensureFx(trackNum, fxNum, paramNum);
    const fxInfo = ensureFx(trackNum, fxNum, 1);
    return {
        ...state,
        fxName: fxInfo.fxName || state.fxName,
        bypass: fxInfo.bypass
    };
}

function buildFxParamSvg(state, settings) {
    const w = 144, h = 144;
    const value = Math.max(0, Math.min(1, state.value));
    const bypass = state.bypass;
    const bg = bypass ? '#332211' : '#1a1a2e';
    const color = bypass ? '#888888' : '#33ccff';

    const pct = Math.round(value * 100);
    return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <rect width="${w}" height="${h}" fill="${bg}"/>
        <text x="72" y="18" font-family="Arial" font-size="10" font-weight="bold" fill="#aaaaaa" text-anchor="middle">${escapeXml(truncate(state.fxName, 22))}</text>
        <text x="72" y="48" font-family="Arial" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(truncate(state.name, 18))}</text>
        <rect x="18" y="72" width="108" height="20" fill="#333333" rx="3"/>
        <rect x="18" y="72" width="${Math.round(value * 108)}" height="20" fill="${color}" rx="3"/>
        <text x="72" y="118" font-family="Arial" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${pct}%</text>
        ${bypass ? '<text x="72" y="138" font-family="Arial" font-size="10" fill="#ff9900" text-anchor="middle">BYPASSED</text>' : ''}
    </svg>`);
}

function renderFxParam(context, settings) {
    const state = getFxParamState(settings);
    plugin.setImage(context, buildFxParamSvg(state, settings));
    plugin.setTitle(context, '');
}

// ─────────────── Peak decay timer ───────────────
function startRenderTimer() {
    if (renderInterval) return;
    renderInterval = setInterval(() => {
        let changed = false;
        const now = Date.now();
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
plugin.deviceDidConnect = () => {
    if (!oscClient) initOsc();
    startRenderTimer();
};

plugin.didReceiveGlobalSettings = ({ payload: { settings } }) => {
    Plugins.globalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...(settings || {}) };
    if (!oscClient) initOsc();
    scheduleRender();
};

// ─────────────── Action: channelstrip ───────────────
plugin.channelstrip = new Actions({
    default: {
        trackNumber: 1,
        followBank: false,
        bankOffset: 1,
        pressAction: 'mute',
        showPeak: true,
        labelSize: 13
    },

    _willAppear({ context, payload: { settings } }) {
        const merged = { ...this.default, ...settings };
        activeContexts.set(context, { action: 'channelstrip', settings: merged });
        if (!oscClient) initOsc();
        startRenderTimer();
        renderChannelStrip(context, merged);
        const trackNum = getTrackNumber(merged);
        sendOsc(`/track/${trackNum}/volume`, []);
        sendOsc(`/track/${trackNum}/mute`, []);
        sendOsc(`/track/${trackNum}/solo`, []);
        sendOsc(`/track/${trackNum}/recarm`, []);
        sendOsc(`/track/${trackNum}/name`, []);
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
    },

    keyUp({ context }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const trackNum = getTrackNumber(settings);
        const action = settings.pressAction || 'mute';
        if (action === 'mute') sendOsc(`/track/${trackNum}/mute`, [1]);
        else if (action === 'solo') sendOsc(`/track/${trackNum}/solo`, [1]);
        else if (action === 'recarm') sendOsc(`/track/${trackNum}/recarm`, [1]);
        else if (action === 'select') sendOsc(`/track/${trackNum}/select`, [1]);
    },

    _didReceiveSettings({ context }) {
        const settings = this.data[context];
        if (activeContexts.has(context)) {
            activeContexts.get(context).settings = settings;
            renderChannelStrip(context, settings);
        }
    }
});

// ─────────────── Action: channelfader (Knob) ───────────────
plugin.channelfader = new Actions({
    default: {
        trackNumber: 1,
        followBank: false,
        bankOffset: 1,
        knobAction: 'volume',
        sensitivity: 1.0
    },

    _willAppear({ context, payload: { settings } }) {
        const merged = { ...this.default, ...settings };
        activeContexts.set(context, { action: 'channelfader', settings: merged });
        if (!oscClient) initOsc();
        startRenderTimer();
        renderChannelFader(context, merged);
        const trackNum = getTrackNumber(merged);
        sendOsc(`/track/${trackNum}/volume`, []);
        sendOsc(`/track/${trackNum}/mute`, []);
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
    },

    dialRotate({ context, payload }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const trackNum = getTrackNumber(settings);
        const ticks = payload.ticks || 0;
        const sens = settings.sensitivity || 1.0;
        if (settings.knobAction === 'pan') {
            const delta = ticks * 0.02 * sens;
            sendOsc(`/track/${trackNum}/pan`, [delta]);
        } else {
            const delta = ticks * 0.5 * sens;
            sendOsc(`/track/${trackNum}/volume/db`, [delta > 0 ? `+${delta}` : `${delta}`]);
        }
    },

    dialDown({ context }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const trackNum = getTrackNumber(settings);
        sendOsc(`/track/${trackNum}/mute`, [1]);
    },

    _didReceiveSettings({ context }) {
        const settings = this.data[context];
        if (activeContexts.has(context)) {
            activeContexts.get(context).settings = settings;
            renderChannelFader(context, settings);
        }
    }
});

// ─────────────── Action: transport ───────────────
plugin.transport = new Actions({
    default: { command: 'play' },

    _willAppear({ context, payload: { settings } }) {
        const merged = { ...this.default, ...settings };
        activeContexts.set(context, { action: 'transport', settings: merged });
        if (!oscClient) initOsc();
        startRenderTimer();
        renderTransport(context, merged);
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
    },

    keyUp({ context }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const cmd = settings.command || 'play';
        switch (cmd) {
            case 'play': sendOsc('/play', [1]); break;
            case 'stop': sendOsc('/stop', [1]); break;
            case 'pause': sendOsc('/pause', [1]); break;
            case 'record': sendOsc('/record', [1]); break;
            case 'click': sendOsc('/click', [1]); break;
            case 'repeat': sendOsc('/repeat', [1]); break;
        }
    },

    _didReceiveSettings({ context }) {
        const settings = this.data[context];
        if (activeContexts.has(context)) {
            activeContexts.get(context).settings = settings;
            renderTransport(context, settings);
        }
    }
});

// ─────────────── Action: bank ───────────────
plugin.bank = new Actions({
    default: { direction: 'next', bankSize: 8 },

    _willAppear({ context, payload: { settings } }) {
        const merged = { ...this.default, ...settings };
        activeContexts.set(context, { action: 'bank', settings: merged });
        renderBank(context, merged);
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
    },

    keyUp({ context }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const gs = getGlobalSettings();
        const size = settings.bankSize || gs.bankSize || 8;
        let bank = gs.currentBank || 0;
        if (settings.direction === 'next') bank++;
        else bank = Math.max(0, bank - 1);
        const newGlobals = { ...gs, currentBank: bank, bankSize: size };
        plugin.setGlobalSettings(newGlobals);
        scheduleRender();
    },

    _didReceiveSettings({ context }) {
        const settings = this.data[context];
        if (activeContexts.has(context)) {
            activeContexts.get(context).settings = settings;
            renderBank(context, settings);
        }
    }
});

// ─────────────── Action: fxparam ───────────────
plugin.fxparam = new Actions({
    default: {
        trackNumber: 1,
        fxNumber: 1,
        paramNumber: 1,
        lastTouched: false,
        pressAction: 'bypass',
        sensitivity: 1.0
    },

    _willAppear({ context, payload: { settings } }) {
        const merged = { ...this.default, ...settings };
        activeContexts.set(context, { action: 'fxparam', settings: merged });
        if (!oscClient) initOsc();
        startRenderTimer();
        renderFxParam(context, merged);
        if (!merged.lastTouched) {
            const t = merged.trackNumber || 1;
            const f = merged.fxNumber || 1;
            const p = merged.paramNumber || 1;
            sendOsc(`/track/${t}/fx/${f}/fxparam/${p}/value`, []);
            sendOsc(`/track/${t}/fx/${f}/fxparam/${p}/name`, []);
            sendOsc(`/track/${t}/fx/${f}/name`, []);
        }
    },

    _willDisappear({ context }) {
        activeContexts.delete(context);
    },

    keyUp({ context }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        if (settings.lastTouched) return;
        const t = settings.trackNumber || 1;
        const f = settings.fxNumber || 1;
        const action = settings.pressAction || 'bypass';
        if (action === 'bypass') sendOsc(`/track/${t}/fx/${f}/bypass`, [1]);
        else if (action === 'openui') sendOsc(`/track/${t}/fx/${f}/openui`, [1]);
    },

    dialRotate({ context, payload }) {
        const settings = activeContexts.get(context)?.settings || this.default;
        const ticks = payload.ticks || 0;
        const sens = settings.sensitivity || 1.0;
        const delta = ticks * 0.01 * sens;
        if (settings.lastTouched) {
            // REAPER does not expose a "set last touched param" via OSC,
            // but we can at least reflect the value from feedback.
            return;
        }
        const t = settings.trackNumber || 1;
        const f = settings.fxNumber || 1;
        const p = settings.paramNumber || 1;
        const current = ensureFx(t, f, p).value;
        const newValue = Math.max(0, Math.min(1, current + delta));
        sendOsc(`/track/${t}/fx/${f}/fxparam/${p}/value`, [newValue]);
    },

    _didReceiveSettings({ context }) {
        const settings = this.data[context];
        if (activeContexts.has(context)) {
            activeContexts.get(context).settings = settings;
            renderFxParam(context, settings);
        }
    }
});

log.info('ReaperControl plugin backend started');
