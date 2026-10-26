// Coming back to the app after a while (phone unlocked, app brought to the front, or iOS restoring
// it from its page cache): tell the app to refresh, and if the computer has a newer build of the remote,
// switch to it. A reload only happens once the new page has answered, so it can never go blank.
const AWAY_MS = 60000;

function currentBuild() {
  const s = document.querySelector('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src, location.href).pathname : null;
}

async function checkBuild() {
  const mine = currentBuild();
  if (!mine) return;                                   // dev server: nothing to compare
  try {
    const r = await fetch('/', { cache: 'no-store' });
    if (!r.ok) return;
    const html = await r.text();
    const theirs = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    if (!theirs || theirs === mine) return;
    const js = await fetch(theirs, { cache: 'no-store' });
    if (js.ok) location.reload();
  } catch { /* the computer is not answering yet; the app shows that itself */ }
}

export function watchLifecycle() {
  let hiddenAt = 0;
  const resume = () => {
    window.dispatchEvent(new Event('tv:resume'));
    checkBuild();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) resume();
    else window.dispatchEvent(new Event('tv:resume'));
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) resume(); });
  window.addEventListener('online', () => window.dispatchEvent(new Event('tv:resume')));
}
