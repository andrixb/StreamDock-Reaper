/**
 * Minimal OSC 1.0 encoder/decoder over UDP for REAPER control.
 *
 * Supported argument types: int32 (i), float32 (f), string (s), T/F/N/I.
 * Incoming bundles (#bundle) are unpacked recursively — REAPER packs its
 * feedback into bundles, so this is required to receive anything at all.
 *
 * Outgoing args:
 *   - JS number  -> float32 ('f')  (REAPER accepts floats for every type)
 *   - string     -> 's'
 *   - boolean    -> 'T' / 'F'
 *   - { type: 'i' | 'f' | 's', value } for an explicit type
 */
const dgram = require('dgram');

const pad4 = (n) => (n + 3) & ~3;

function encodeString(str) {
    const raw = Buffer.from(String(str), 'utf8');
    const buf = Buffer.alloc(pad4(raw.length + 1)); // always at least one NUL
    raw.copy(buf, 0);
    return buf;
}

function encodeArg(arg) {
    if (arg && typeof arg === 'object' && 'type' in arg) {
        if (arg.type === 'i') {
            const buf = Buffer.alloc(4);
            buf.writeInt32BE(Math.trunc(arg.value) | 0, 0);
            return { tag: 'i', buf };
        }
        if (arg.type === 's') return { tag: 's', buf: encodeString(arg.value) };
        arg = Number(arg.value);
    }
    if (typeof arg === 'number') {
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(Number.isFinite(arg) ? arg : 0, 0);
        return { tag: 'f', buf };
    }
    if (typeof arg === 'boolean') return { tag: arg ? 'T' : 'F', buf: Buffer.alloc(0) };
    if (typeof arg === 'string') return { tag: 's', buf: encodeString(arg) };
    return { tag: 'N', buf: Buffer.alloc(0) };
}

function encodeMessage(address, args = []) {
    args = Array.isArray(args) ? args : [args];
    const encoded = args.map(encodeArg);
    const tags = ',' + encoded.map((e) => e.tag).join('');
    return Buffer.concat([encodeString(address), encodeString(tags), ...encoded.map((e) => e.buf)]);
}

function readString(buf, offset) {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    return { value: buf.toString('utf8', offset, end), next: offset + pad4(end - offset + 1) };
}

function decodeMessage(buf) {
    const addr = readString(buf, 0);
    let offset = addr.next;
    const args = [];
    if (offset >= buf.length) return { address: addr.value, args };
    const tagRes = readString(buf, offset);
    offset = tagRes.next;
    const tags = tagRes.value;
    for (let i = 1; i < tags.length; i++) {
        switch (tags[i]) {
            case 'f': args.push(buf.readFloatBE(offset)); offset += 4; break;
            case 'i': args.push(buf.readInt32BE(offset)); offset += 4; break;
            case 'd': args.push(buf.readDoubleBE(offset)); offset += 8; break;
            case 'h': args.push(Number(buf.readBigInt64BE(offset))); offset += 8; break;
            case 's':
            case 'S': {
                const r = readString(buf, offset);
                args.push(r.value);
                offset = r.next;
                break;
            }
            case 'b': {
                const len = buf.readInt32BE(offset);
                args.push(buf.subarray(offset + 4, offset + 4 + len));
                offset += 4 + pad4(len);
                break;
            }
            case 'T': args.push(true); break;
            case 'F': args.push(false); break;
            case 'I': args.push(true); break;
            case 'N': args.push(null); break;
            default: return { address: addr.value, args }; // unknown tag: stop parsing safely
        }
    }
    return { address: addr.value, args };
}

/** Decode a UDP packet into a flat list of { address, args } (bundles unpacked). */
function decodePacket(buf, out = []) {
    if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
        let offset = 16; // "#bundle\0" + 8-byte timetag
        while (offset + 4 <= buf.length) {
            const size = buf.readInt32BE(offset);
            offset += 4;
            if (size <= 0 || offset + size > buf.length) break;
            decodePacket(buf.subarray(offset, offset + size), out);
            offset += size;
        }
        return out;
    }
    out.push(decodeMessage(buf));
    return out;
}

class OscClient {
    constructor(options = {}) {
        this.host = options.host || '127.0.0.1';
        this.sendPort = options.sendPort || 8000;
        this.recvPort = options.recvPort || 9000;
        this.onMessage = options.onMessage || (() => {});
        this.onError = options.onError || (() => {});
        this.onReady = options.onReady || (() => {});
        this.socket = null;
        this.ready = false;
    }

    open() {
        if (this.socket) return;
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        this.socket = socket;
        socket.on('error', (err) => {
            this.ready = false;
            this.onError(err);
        });
        socket.on('message', (msg) => {
            let messages;
            try {
                messages = decodePacket(msg);
            } catch (e) {
                this.onError(e);
                return;
            }
            for (const m of messages) {
                try { this.onMessage(m.address, m.args); } catch (e) { this.onError(e); }
            }
        });
        socket.bind(this.recvPort, () => {
            this.ready = true;
            this.onReady();
        });
    }

    close() {
        if (!this.socket) return;
        try { this.socket.close(); } catch (e) { /* already closed */ }
        this.socket = null;
        this.ready = false;
    }

    send(address, args = []) {
        if (!this.socket) return;
        const msg = encodeMessage(address, args);
        this.socket.send(msg, this.sendPort, this.host, (err) => {
            if (err) this.onError(err);
        });
    }
}

module.exports = { OscClient, encodeMessage, decodeMessage, decodePacket };
