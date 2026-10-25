// keepalive.js — BUILD-ONLY. Never shipped as-is. `npm run build` ncc-bundles
// this into build-keepalive/index.js, and autofile.js writes that bundle over
// the installed plugin/index.js to hand the backend over without a crash-loop.
// Rationale: docs/superpowers/specs/2026-06-09-keepalive-build-handoff-design.md
//
// StreamDock relaunches plugin/index.js on ANY process death and gives up after
// 50 restarts. This keep-alive becomes the live plugin (so the relaunch target is
// always valid) while the real files are copied in, then overwrites itself with
// the production bundle and exits to trigger the final relaunch.
//
// Runs in StreamDock's bundled Node 20 with NO node_modules, so it uses only
// built-ins plus `ws` (which ncc bundles into the single output file).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const WebSocket = require('ws');

const here = __dirname; // the installed <plugin>/plugin folder at runtime
const taskFile = path.join(here, '.keepalive-task.json');
const doneFile = path.join(here, '.keepalive-done');
const errFile = path.join(here, '.keepalive-error');
const logFile = path.join(here, 'log', 'keepalive.log');

function log(msg) {
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch { /* logging must never throw */ }
}

function fail(err) {
    const msg = (err && err.stack) || String(err);
    log('ERROR ' + msg);
    try { fs.writeFileSync(errFile, msg); } catch { /* ignore */ }
    process.exit(1);
}

// Read the task into memory BEFORE any copy can touch it.
let task;
try {
    task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
} catch (e) {
    fail('cannot read .keepalive-task.json: ' + e);
}
// task = { srcDir, buildDir, pluginPath, skip: string[] }

const skip = task.skip || [];
function copyFilter(src) {
    const rel = path.relative(task.srcDir, src);
    if (!rel) return true; // the root itself
    return !skip.some(s => rel === s || rel.startsWith(s + path.sep));
}

async function doSwap() {
    // 1. source .sdPlugin -> install path, skipping dev-only files + plugin/index.js
    await fsp.cp(task.srcDir, task.pluginPath, { recursive: true, force: true, filter: copyFilter });
    // 2. production bundle -> install path/plugin; this overwrites THIS running
    //    keep-alive's own index.js with the real backend (the handoff).
    await fsp.cp(task.buildDir, path.join(task.pluginPath, 'plugin'), { recursive: true, force: true });
    // 3. signal completion for autofile.js, then drop the task file.
    fs.writeFileSync(doneFile, 'ok');
    try { fs.rmSync(taskFile, { force: true }); } catch { /* ignore */ }
}

// Connect to StreamDock first so it does not kill us for not registering, THEN
// copy asynchronously (keeps the event loop free to answer heartbeats).
const sock = new WebSocket('ws://127.0.0.1:' + process.argv[3]);
sock.on('open', () => {
    sock.send(JSON.stringify({ uuid: process.argv[5], event: process.argv[7] }));
    log('registered; starting swap');
    doSwap()
        .then(() => { log('swap complete; handing off'); try { sock.close(); } catch {} process.exit(0); })
        .catch(fail);
});
sock.on('error', (e) => fail('websocket error: ' + e));
