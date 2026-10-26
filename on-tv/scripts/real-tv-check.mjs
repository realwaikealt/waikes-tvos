// Real-TV checks for on-TV mode, over HTTP only (see ../REAL-TV-TEST.md).
// Safe on a TV in a sleeping house: it never changes the volume, never plays anything, and never
// touches any app other than Settings and the home screen.
//
//   node real-tv-check.mjs pair --base http://<TV_IP>:5400 --code <6 digits from the TV>
//   node real-tv-check.mjs run  --base http://<TV_IP>:5400
//
// The token is kept in test-output/real-tv-token (git-ignored) between the two steps.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k) => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : null; };
const BASE = opt('base');
if (!BASE || !/^http:\/\/[\d.]+:\d+$/.test(BASE)) { console.error('need --base http://<ip>:<port>'); process.exit(2); }
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');
mkdirSync(OUT, { recursive: true });
const TOKEN_FILE = path.join(OUT, 'real-tv-token');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function call(method, p, body, token) {
  const h = {}; if (body) h['content-type'] = 'application/json'; if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, d }); console.log('PASS ', name, JSON.stringify(d ?? '').slice(0, 200)); }
  catch (e) { results.push({ name, pass: false, d: String(e.message || e) }); console.log('FAIL ', name, String(e.message || e).slice(0, 200)); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

if (cmd === 'pair') {
  const r = await call('POST', '/api/pair', { pin: opt('code'), name: 'real-tv-check' });
  if (r.status !== 200) { console.log('pairing failed:', r.json && r.json.error); process.exit(1); }
  writeFileSync(TOKEN_FILE, r.json.token, { mode: 0o600 });
  console.log('paired, token saved (not printed)');
} else if (cmd === 'run') {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  await check('health without a token says auth required', async () => { const r = await call('GET', '/api/health'); assert(r.json.auth === 'required', JSON.stringify(r.json)); return r.json; });
  await check('control endpoints are 401 without a token', async () => {
    const got = {}; for (const [m, p, b] of [['GET', '/api/now'], ['POST', '/api/key', { key: 'home' }], ['GET', '/api/adb'], ['POST', '/api/power', { state: 'off' }]]) got[p] = (await call(m, p, b)).status;
    assert(Object.values(got).every((s) => s === 401), JSON.stringify(got)); return got;
  });
  await check('now (with token): power, app, volume (check muted is true)', async () => { const r = await call('GET', '/api/now', null, token); return { power: r.json.power, app: r.json.app, volume: r.json.volume, adb: r.json.adb }; });
  await check('ADB status', async () => (await call('GET', '/api/adb', null, token)).json);
  await check('app list', async () => { const r = await call('GET', '/api/apps', null, token); return r.json.apps.filter((a) => a.installed).map((a) => a.id); });
  await check('open Settings', async () => { const r = await call('POST', '/api/launch', { app: 'settings' }, token); assert(r.status === 200, JSON.stringify(r.json)); return r.json.app; });
  await sleep(2000);
  await check('D-pad down (in Settings)', async () => { const r = await call('POST', '/api/key', { key: 'down' }, token); assert(r.status === 200, JSON.stringify(r.json)); return r.json; });
  await sleep(5000);
  await check('what is in front after the key', async () => (await call('GET', '/api/now', null, token)).json.app);
  await check('HOME key', async () => { const r = await call('POST', '/api/key', { key: 'home' }, token); assert(r.status === 200, JSON.stringify(r.json)); return r.json; });
  await sleep(5000);   // /api/now refreshes the app in front every 4 s
  await check('home is in front (the live launcher, not this app)', async () => (await call('GET', '/api/now', null, token)).json.app);
  await check('find a show (JustWatch from the TV, nothing played)', async () => { const r = await call('GET', '/api/find?title=Bluey', null, token); assert(r.status === 200, JSON.stringify(r.json)); return r.json.result.providers.map((p) => p.service + (p.playable ? '' : ' (not on TV)')); });
  await check('ask is off (501)', async () => { const r = await call('POST', '/api/ask', { text: 'hello' }, token); assert(r.status === 501, 'status ' + r.status); return r.json.error; });
  await check('volume at the end (check muted is still true)', async () => { const v = (await call('GET', '/api/now', null, token)).json.volume; return v; });
  writeFileSync(path.join(OUT, 'real-tv-results.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.filter((r) => r.pass).length} passed, ${results.filter((r) => !r.pass).length} failed`);
} else { console.error('pair or run'); process.exit(2); }
