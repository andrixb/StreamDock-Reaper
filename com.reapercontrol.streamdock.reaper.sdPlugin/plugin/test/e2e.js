// End-to-end test: mock StreamDock (WebSocket) + fake REAPER (UDP on 18000/19000).
// Run: npm test
const path = require('path');
const os = require('os');
const fs = require('fs');
const P = path.resolve(__dirname, '..');
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reapercontrol-test-'));
const { WebSocketServer } = require(P + '/node_modules/ws');
const { encodeMessage, decodePacket } = require(P + '/utils/osc');
const dgram = require('dgram');
const { spawn } = require('child_process');

const results = []; const check = (name, ok, extra='') => { results.push([name, !!ok]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fake REAPER: listens on 18000, sends feedback to 19000
const reaperRx = []; const reaper = dgram.createSocket('udp4');
reaper.on('message', m => decodePacket(m).forEach(x => reaperRx.push(x)));
reaper.bind(18000);
function bundle(msgs) {
  const parts = [Buffer.from('#bundle\0'), Buffer.alloc(8)];
  for (const [a, args] of msgs) { const m = encodeMessage(a, args); const sz = Buffer.alloc(4); sz.writeInt32BE(m.length); parts.push(sz, m); }
  return Buffer.concat(parts);
}
const toPlugin = (buf, port = 19000) => reaper.send(buf, port, '127.0.0.1');

// Mock StreamDock
const wss = new WebSocketServer({ port: 0 });
const images = {}; let sock; const sent = [];
wss.on('connection', s => {
  sock = s;
  s.on('message', raw => {
    const d = JSON.parse(raw); sent.push(d);
    if (d.event === 'setImage') images[d.context] = decodeURIComponent(d.payload.image.split(',')[1]);
    if (d.event === 'getGlobalSettings') s.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { oscHost: '127.0.0.1', oscSendPort: 18000, oscRecvPort: 19000 } } }));
  });
});
const U = 'com.reapercontrol.streamdock.reaper.';
const ev = (event, action, context, payload = {}) => sock.send(JSON.stringify({ event, action: U + action, context, payload }));

(async () => {
  await new Promise(r => wss.on('listening', r));
  const port = wss.address().port;
  const info = JSON.stringify({ application: { language: 'en' } });
  const child = spawn(process.execPath, [P + '/index.js', '-port', port, '-pluginUUID', 'TEST', '-registerEvent', 'registerPlugin', '-info', info], { cwd: logDir, stdio: 'inherit' });
  await sleep(500);
  ev('deviceDidConnect'); // first message triggers getGlobalSettings
  await sleep(200);
  ev('willAppear', 'channelstrip', 'cs1', { settings: { trackNumber: 1 } });
  ev('willAppear', 'channelfader', 'cf1', { settings: { trackNumber: 1 } });
  ev('willAppear', 'transport', 'tp1', { settings: { command: 'play' } });
  ev('willAppear', 'fxparam', 'fx1', { settings: { trackNumber: 2, fxNumber: 1, paramNumber: 3 } });
  ev('willAppear', 'bank', 'bk1', { settings: { direction: 'next' } });
  await sleep(400);
  check('refresh action sent to REAPER', reaperRx.some(m => m.address === '/action/41743'));
  check('offline badge before REAPER answers', images.cs1?.includes('NO REAPER'));
  check('transport icon is a shape, not a glyph', images.tp1?.includes('<polygon'));

  toPlugin(bundle([['/track/1/name', ['Kick']], ['/track/1/vu', [0.8]], ['/track/1/mute', [1]], ['/track/1/volume/db', [-6]],
                   ['/play', [1]], ['/track/2/fx/1/name', ['ReaEQ']], ['/track/2/fx/1/fxparam/3/name', ['Gain']], ['/track/2/fx/1/fxparam/3/value', [0.25]]]));
  await sleep(300);
  check('bundle decoded: name on strip', images.cs1?.includes('Kick'));
  check('mute badge', images.cs1?.includes('MUTE'));
  check('offline badge cleared', !images.cs1?.includes('NO REAPER'));
  check('fader shows -6.0 dB', images.cf1?.includes('-6.0 dB'));
  check('fx param shows names', images.fx1?.includes('ReaEQ') && images.fx1?.includes('Gain') && images.fx1?.includes('25%'));

  reaperRx.length = 0;
  ev('keyUp', 'channelstrip', 'cs1');
  ev('dialRotate', 'channelfader', 'cf1', { ticks: 2 });
  ev('keyUp', 'transport', 'tp1');
  ev('dialRotate', 'fxparam', 'fx1', { ticks: 5 });
  ev('dialDown', 'channelfader', 'cf1');
  await sleep(300);
  const find = a => reaperRx.find(m => m.address === a);
  check('mute toggle sent', find('/track/1/mute/toggle'));
  check('volume absolute dB sent (-5)', find('/track/1/volume/db')?.args[0] === -5, JSON.stringify(find('/track/1/volume/db')));
  check('play key while playing sends /stop', find('/stop') && !find('/play'));
  check('fx param value 0.30', Math.abs((find('/track/2/fx/1/fxparam/3/value')?.args[0] ?? 0) - 0.30) < 1e-4);

  const gsBefore = sent.filter(d => d.event === 'setGlobalSettings').length;
  ev('keyUp', 'bank', 'bk1');
  await sleep(200);
  const gs = sent.filter(d => d.event === 'setGlobalSettings').pop();
  check('bank next -> currentBank 1, ports kept', gs && gs.payload.currentBank === 1 && gs.payload.oscSendPort === 18000 && sent.filter(d => d.event === 'setGlobalSettings').length === gsBefore + 1);
  check('bank key shows Tracks 9-16', images.bk1?.includes('Tracks 9-16'));

  // Port change re-binds
  sock.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { oscHost: '127.0.0.1', oscSendPort: 18000, oscRecvPort: 19001 } } }));
  await sleep(400);
  toPlugin(bundle([['/track/1/name', ['Snare']]]), 19001);
  await sleep(300);
  check('re-bound to new recv port after settings change', images.cs1?.includes('Snare'));

  toPlugin(bundle([['/track/1/vu', [0]]]), 19001);
  await sleep(3000); // let peak-hold decay finish
  const setImages = sent.filter(d => d.event === 'setImage').length;
  await sleep(1000);
  check('no redundant setImage when idle', sent.filter(d => d.event === 'setImage').length === setImages);

  child.kill(); reaper.close(); wss.close();
  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
