// Thin client for the bridge (../../bridge/API.md). Relative URLs, so it works from any phone at home.
import { request, noteError, noteOk } from './net.js';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Which TV this phone is driving. null means the bridge's default (the default TV), and then
// nothing is added to any call, exactly as before more than one TV existed.
let tvId = null;
export const setTvId = (id) => { tvId = id || null; };
const withTv = (path) => (tvId ? `${path}${path.includes('?') ? '&' : '?'}tv=${encodeURIComponent(tvId)}` : path);

// Every call gives up in the end, so the app never sits on "Loading" for ever.
// Ask and play wait longer: Claude thinks first, and waking a TV takes up to 25 s.
async function call(method, path, body, ms = 12000) {
  let res;
  if (tvId) { if (method === 'GET') path = withTv(path); else body = { ...(body || {}), tv: tvId }; }
  try {
    res = await request(method, path, body ? JSON.stringify(body) : undefined, ms);
  } catch (e) {
    noteError({ name: e.name, message: e.message, url: path, via: e.via });
    throw e.name === 'AbortError' ? new ApiError('The bridge is taking too long. Try again.', 408) : new ApiError('Can’t reach the bridge', 0);
  }
  res.ok = res.status >= 200 && res.status < 300;
  noteOk();
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* non-JSON */ }
  if (!res.ok || !data || data.ok === false) {
    const msg = data?.error || (res.status === 503 ? 'TV not connected' : res.status === 404 ? 'Not found' : 'Something went wrong');
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const api = {
  now: () => call('GET', '/api/now'),
  apps: () => call('GET', '/api/apps'),
  recs: (who) => call('GET', `/api/recs?who=${encodeURIComponent(who)}`),
  continueList: (who) => call('GET', `/api/continue?who=${encodeURIComponent(who)}`),
  setWho: (who) => call('POST', '/api/who', { who }),
  openContinue: (id, who) => call('POST', '/api/continue/open', { id, who }, 60000),
  config: () => call('GET', '/api/config'),
  screensaver: () => call('POST', '/api/screensaver'),
  screens: () => call('GET', '/api/screens'),
  sleep: () => call('GET', '/api/sleep'),
  key: (key, hold = false) => call('POST', '/api/key', hold ? { key, hold: true } : { key }),
  text: (text, extra) => call('POST', '/api/text', { text, ...(extra || {}) }),
  webapp: (cmd, text) => call('POST', '/api/webapp', text === undefined ? { cmd } : { cmd, text }),
  launch: (app) => call('POST', '/api/launch', { app }),
  play: (show, who) => call('POST', '/api/play', { ...show, who }, 60000),
  ask: (text, who) => call('POST', '/api/ask', { text, who }, 90000),
  power: (state) => call('POST', '/api/power', { state }, 40000),
  volume: (action, steps) => call('POST', '/api/volume', steps ? { action, steps } : { action }),
  setSleep: (minutes) => call('POST', '/api/sleep', { minutes }),
  openScreen: (id) => call('POST', '/api/screens/open', { id }),
  tvs: () => call('GET', '/api/tvs'),
  healthAll: () => call('GET', '/api/health/all', null, 30000),
  picture: (mode) => call('POST', '/api/picture', { mode }, 20000),   // a picture switch can take several seconds
  appOrder: () => call('GET', '/api/app-order'),
  saveAppOrder: (order, line) => call('POST', '/api/app-order', { order, line, manual: true }),
  arrange: () => call('GET', '/api/arrange'),
  arrangeSet: (body) => call('POST', '/api/arrange', body),
  getPicture: () => call('GET', '/api/picture'),
  tvPage: (what) => call('POST', '/api/tvpage', { what }),
  people: () => call('GET', '/api/people'),
  savePeople: (people) => call('POST', '/api/people', { people }),
  webapps: () => call('GET', '/api/webapps'),
  webappsSet: (body) => call('POST', '/api/webapps', body),
  wallpapers: () => call('GET', '/api/wallpapers', null, 20000),
  wallpaperNow: () => call('GET', '/api/wallpaper'),
  wallpaperSet: (id) => call('POST', '/api/wallpaper', { id, t: Date.now() }, 20000),
  backupNow: () => call('POST', '/api/backup/save', {}, 20000),
  restoreLatest: () => call('POST', '/api/restore', { latest: true }, 30000),
  restart: (what) => call('POST', '/api/restart', { what }, 15000),
  restartState: () => call('GET', '/api/restart'),
};

// Live TV state: server-sent events, with a slow poll as the fallback when the stream drops.
export function subscribeNow(onNow, onReach) {
  let es; let poll; let retry; let closed = false; let fails = 0;
  const start = () => {
    if (closed) return;
    clearTimeout(retry);
    es?.close();
    if (typeof EventSource !== 'function' || fails >= 2) {
      // The live stream does not work here (or keeps dropping): ask for the state every 2 s instead.
      const tickPoll = () => { if (closed) return; api.now().then((d) => { onReach(true); onNow(d); }).catch((err) => onReach(!(err.status === 0 || err.status === 408))).finally(() => { retry = setTimeout(tickPoll, 2000); }); };
      tickPoll();
      return;
    }
    es = new EventSource(withTv('/api/events'));
    es.addEventListener('now', (e) => { fails = 0; onReach(true); try { onNow(JSON.parse(e.data)); } catch { /* ignore */ } });
    es.onerror = () => {
      es.close(); fails += 1;
      api.now().then((d) => { onReach(true); onNow(d); }).catch((err) => onReach(!(err.status === 0 || err.status === 408)));
      // Back off 2, 4, 8 s up to 15 s while the computer is away (it restarts, or the phone is off the Wi-Fi).
      retry = setTimeout(start, Math.min(15000, 1000 * 2 ** fails));
    };
  };
  start();
  // When the phone wakes or the app comes back to the front, refresh straight away. While the computer
  // is not answering, keep checking quickly (2, 4, 8, then every 15 s), so the remote comes back
  // by itself within seconds of the computer, not on the next 30 s poll.
  let away = 0; let recheck;
  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    clearTimeout(recheck);
    api.now().then((d) => { away = 0; onReach(true); onNow(d); }).catch((err) => {
      const gone = err.status === 0 || err.status === 408;
      onReach(!gone);
      if (gone && !closed) { away += 1; recheck = setTimeout(wake, Math.min(15000, 1000 * 2 ** away)); }
    });
  };
  // Back from the lock screen or the page cache: iOS may have dropped the live stream, so reopen it.
  const resume = () => { wake(); if (!es || es.readyState === 2) { fails = 0; start(); } };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('tv:resume', resume);
  poll = setInterval(wake, 30000);
  return () => { closed = true; es?.close(); clearTimeout(retry); clearTimeout(recheck); clearInterval(poll); document.removeEventListener('visibilitychange', wake); window.removeEventListener('tv:resume', resume); };
}
