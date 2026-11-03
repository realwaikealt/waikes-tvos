// Network layer for the phone remote: fetch first, XMLHttpRequest if fetch fails, and a record of the last
// failure so the app can show what really went wrong (iOS only says "Load failed").

export const netState = { last: null, via: 'fetch' };   // last = { name, message, url, status, via, at }
const listeners = new Set();
export const onNetChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export function noteError(info) { netState.last = { ...info, at: new Date().toLocaleTimeString() }; listeners.forEach((f) => f(netState.last)); }
export function noteOk() { if (netState.last) { netState.last = null; listeners.forEach((f) => f(null)); } }

export const isStandalone = () => typeof navigator !== 'undefined' && Boolean(navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));

// One request through XMLHttpRequest. Resolves { status, text } or rejects { name, message }.
export function xhrRequest(method, url, body, headers, ms) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url, true);
    x.timeout = ms;
    Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => reject({ name: 'XHRError', message: 'XMLHttpRequest failed (status 0)' });
    x.ontimeout = () => reject({ name: 'AbortError', message: 'timeout' });
    x.send(body || null);
  });
}

// fetch with a timeout; on a network failure (not a timeout) try XHR before giving up.
export async function request(method, url, body, ms) {
  const headers = body ? { 'content-type': 'application/json' } : undefined;
  let fe = null;
  if (netState.via === 'fetch' && typeof fetch === 'function') {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), ms);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl ? ctl.signal : undefined });
      return { status: res.status, text: await res.text(), via: 'fetch' };
    } catch (e) {
      if (e && e.name === 'AbortError') throw { name: 'AbortError', message: 'timeout', via: 'fetch', url };
      fe = e;
    } finally { clearTimeout(t); }
  }
  try {
    const r = await xhrRequest(method, url, body, headers, ms);
    if (fe) netState.via = 'xhr';        // fetch is broken here, stay on XHR
    return { ...r, via: 'xhr' };
  } catch (e) {
    const timeout = e.name === 'AbortError';
    throw { name: timeout ? 'AbortError' : (fe && fe.name) || e.name, message: timeout ? 'timeout' : (fe && fe.message) || e.message, via: fe ? 'fetch+xhr' : 'xhr', url };
  }
}

const row = (k, v) => `${k}: ${v}`;
// Runs every transport on its own and returns a copyable report.
export async function connectionTest(onLine) {
  const out = [];
  const add = (s) => { out.push(s); if (onLine) onLine(out.join('\n')); };
  add(row('time', new Date().toString()));
  add(row('page', location.href));
  add(row('standalone', isStandalone()));
  add(row('userAgent', navigator.userAgent));
  const t = async (name, fn) => {
    const t0 = Date.now();
    try { add(row(name, `${await fn()} (${Date.now() - t0} ms)`)); } catch (e) { add(row(name, `FAILED ${(e && e.name) || ''} ${(e && e.message) || e} (${Date.now() - t0} ms)`)); }
  };
  await t('fetch /ping', async () => { const r = await fetch('/ping', { cache: 'no-store' }); return `${r.status} ${(await r.text()).length} bytes`; });
  await t('fetch /api/now', async () => { const r = await fetch('/api/now', { cache: 'no-store' }); const j = await r.json(); return `${r.status} ok=${j.ok}`; });
  await t('xhr /api/now', async () => { const r = await xhrRequest('GET', '/api/now', null, null, 8000); return `${r.status} ${r.text.length} bytes`; });
  await t('event stream', () => new Promise((res, rej) => {
    let es; const to = setTimeout(() => { if (es) es.close(); rej({ name: 'Timeout', message: 'no event in 6 s' }); }, 6000);
    try { es = new EventSource('/api/events'); } catch (e) { clearTimeout(to); rej(e); return; }
    es.addEventListener('now', () => { clearTimeout(to); es.close(); res('first event received'); });
    es.onerror = () => { clearTimeout(to); es.close(); rej({ name: 'EventSourceError', message: 'stream error' }); };
  }));
  await t('page load (no JS fetch)', () => new Promise((res, rej) => {
    const f = document.createElement('iframe'); f.style.display = 'none';
    const to = setTimeout(() => { f.remove(); rej({ name: 'Timeout', message: 'iframe did not load' }); }, 6000);
    f.onload = () => { clearTimeout(to); f.remove(); res('loaded'); };
    f.onerror = () => { clearTimeout(to); f.remove(); rej({ name: 'Error', message: 'iframe error' }); };
    f.src = '/ping?x=' + Date.now(); document.body.appendChild(f);
  }));
  add('done');
  return out.join('\n');
}
