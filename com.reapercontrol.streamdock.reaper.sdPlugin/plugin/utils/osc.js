/**
 * Minimal OSC encoder/decoder for REAPER control.
 * Supports the subset used by this plugin:
 *   int32 (i), float32 (f), string (s)
 */
const dgram = require('dgram');

function pad4(n) {
    return (n + 3) & ~3;
}

function writeString(buf, str, offset) {
    const bytes = Buffer.from(str + '\0', 'utf8');
    bytes.copy(buf, offset);
    return pad4(bytes.length);
}

function encodeAddress(addr) {
    const len = pad4(addr.length + 1);
    const buf = Buffer.alloc(len);
    writeString(buf, addr, 0);
    return buf;
}

function encodeArg(arg) {
    if (typeof arg === 'number') {
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(arg, 0);
        return { tag: 'f', buf };
    }
    if (typeof arg === 'boolean') {
        return { tag: arg ? 'T' : 'F', buf: Buffer.alloc(0) };
    }
    if (typeof arg === 'string') {
        const len = pad4(arg.length + 1);
        const buf = Buffer.alloc(len);
        writeString(buf, arg, 0);
        return { tag: 's', buf };
    }
    if (Number.isInteger(arg)) {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(arg, 0);
        return { tag: 'i', buf };
    }
    return { tag: 'f', buf: Buffer.alloc(4) };
}

function encodeMessage(address, args = []) {
    args = Array.isArray(args) ? args : [args];
    const addrBuf = encodeAddress(address);
    let tags = ',';
    let argBufs = [];
    for (const arg of args) {
        const enc = encodeArg(arg);
        tags += enc.tag;
        argBufs.push(enc.buf);
    }
    const tagBuf = encodeAddress(tags);
    const totalLen = addrBuf.length + tagBuf.length + argBufs.reduce((s, b) => s + b.length, 0);
    const buf = Buffer.alloc(totalLen);
    let offset = 0;
    addrBuf.copy(buf, offset); offset += addrBuf.length;
    tagBuf.copy(buf, offset); offset += tagBuf.length;
    for (const ab of argBufs) {
        ab.copy(buf, offset); offset += ab.length;
    }
    return buf;
}

function readString(buf, offset) {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    const str = buf.toString('utf8', offset, end);
    return { value: str, next: pad4(end + 1) };
}

function decodeMessage(buf) {
    const addrRes = readString(buf, 0);
    let offset = addrRes.next;
    const tagRes = readString(buf, offset);
    offset = tagRes.next;
    const tags = tagRes.value;
    const args = [];
    for (let i = 1; i < tags.length; i++) {
        const tag = tags[i];
        if (tag === 'f') {
            args.push(buf.readFloatBE(offset));
            offset += 4;
        } else if (tag === 'i') {
            args.push(buf.readInt32BE(offset));
            offset += 4;
        } else if (tag === 's') {
            const r = readString(buf, offset);
            args.push(r.value);
            offset = r.next;
        } else if (tag === 'T' || tag === 'I') {
            args.push(true);
        } else if (tag === 'F') {
            args.push(false);
        } else if (tag === 'N') {
            args.push(null);
        } else {
            // Unknown tag, skip 4 bytes as best effort
            offset += 4;
        }
    }
    return { address: addrRes.value, args };
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
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', (err) => {
            this.ready = false;
            this.onError(err);
        });
        this.socket.on('message', (msg) => {
            try {
                const decoded = decodeMessage(msg);
                this.onMessage(decoded.address, decoded.args);
            } catch (e) {
                this.onError(e);
            }
        });
        this.socket.bind(this.recvPort, () => {
            this.ready = true;
            this.onReady();
        });
    }

    close() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
            this.ready = false;
        }
    }

    send(address, args) {
        if (!this.socket) return;
        const msg = encodeMessage(address, args);
        this.socket.send(msg, this.sendPort, this.host, (err) => {
            if (err) this.onError(err);
        });
    }

    sendBundle(messages, timestamp = 0) {
        if (!this.socket) return;
        // #bundle + timetag (8 bytes) + size/message pairs
        const bundleStr = Buffer.from('#bundle\0', 'utf8');
        const timetag = Buffer.alloc(8);
        if (timestamp === 0) {
            timetag.writeUInt32BE(0, 0);
            timetag.writeUInt32BE(1, 4); // immediate
        } else {
            // seconds since 1900 + fraction
            const secs = Math.floor(timestamp);
            timetag.writeUInt32BE(secs + 2208988800, 0);
            timetag.writeUInt32BE(0, 4);
        }
        let body = Buffer.alloc(0);
        for (const m of messages) {
            const msg = encodeMessage(m.address, m.args);
            const size = Buffer.alloc(4);
            size.writeInt32BE(msg.length, 0);
            body = Buffer.concat([body, size, msg]);
        }
        const packet = Buffer.concat([bundleStr, timetag, body]);
        this.socket.send(packet, this.sendPort, this.host, (err) => {
            if (err) this.onError(err);
        });
    }
}

module.exports = { OscClient, encodeMessage, decodeMessage };
