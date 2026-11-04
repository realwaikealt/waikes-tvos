import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Ic from './icons.jsx';
import { tick } from './haptics.js';
import { request } from './net.js';

// PC mode: the phone becomes a touchpad and keyboard for the computer that streams to the TV (Vidbox, Desktop).
// The block lives in the TV sheet; "Open touchpad" opens the full pad. Everything goes through /api/pc/*.
const call = async (method, path, body) => {
  const r = await request(method, path, body === undefined ? undefined : JSON.stringify(body), 10000);
  let j = {};
  try { j = JSON.parse(r.text); } catch (e) { /* not JSON */ }
  return { status: r.status, ...j };
};

const MOVE_GAIN = 1.25;       // base pointer speed
const TAP_MS = 230, TAP_PX = 9, HOLD_MS = 450;

// The touchpad itself. Sends batched events, at most one request in flight, one frame at a time.
function Touchpad({ send, onNote }) {
  const st = useRef({ pts: new Map(), dx: 0, dy: 0, sx: 0, sy: 0, queue: [], busy: false, raf: 0, rem: [0, 0], remS: 0,
    t0: 0, moved: 0, maxPtrs: 0, hold: 0, dragging: false, last: null });

  const flush = useCallback(() => {
    const s = st.current;
    s.raf = 0;
    if (s.busy) { s.raf = requestAnimationFrame(flush); return; }
    const evs = s.queue.splice(0, 30);
    let mx = s.dx + s.rem[0], my = s.dy + s.rem[1];
    s.dx = 0; s.dy = 0;
    const ix = Math.trunc(mx), iy = Math.trunc(my);
    s.rem = [mx - ix, my - iy];
    if (ix || iy) evs.unshift({ t: 'move', dx: ix, dy: iy });
    const sc = s.sy + s.remS;
    s.sy = 0;
    const isc = Math.trunc(sc);
    s.remS = sc - isc;
    if (isc) evs.push({ t: 'scroll', dy: isc });
    if (!evs.length) return;
    s.busy = true;
    send({ events: evs }).finally(() => { s.busy = false; if (s.queue.length || s.dx || s.dy || s.sy) schedule(); });
  }, [send]);

  const schedule = useCallback(() => { const s = st.current; if (!s.raf) s.raf = requestAnimationFrame(flush); }, [flush]);
  const push = useCallback((ev) => { st.current.queue.push(ev); schedule(); }, [schedule]);

  useEffect(() => () => { const s = st.current; cancelAnimationFrame(s.raf); clearTimeout(s.hold); }, []);

  const down = (e) => {
    const s = st.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pts.size === 1) { s.t0 = performance.now(); s.moved = 0; s.maxPtrs = 1; s.last = { x: e.clientX, y: e.clientY, t: s.t0 }; s.dragging = false;
      clearTimeout(s.hold);
      s.hold = setTimeout(() => { if (st.current.moved < TAP_PX && st.current.pts.size === 1) { st.current.dragging = true; tick(); push({ t: 'down', b: 'left' }); } }, HOLD_MS);
    } else { s.maxPtrs = Math.max(s.maxPtrs, s.pts.size); clearTimeout(s.hold); }
  };
  const move = (e) => {
    const s = st.current;
    const p = s.pts.get(e.pointerId);
    if (!p) return;
    const ddx = e.clientX - p.x, ddy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    s.moved += Math.abs(ddx) + Math.abs(ddy);
    if (s.pts.size >= 2) {                         // two fingers scroll: swipe up = scroll down, like the phone itself
      s.sy += (ddy / s.pts.size) * 3;
      schedule();
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - (s.last?.t || now));
    const speed = Math.hypot(ddx, ddy) / dt;       // px per ms
    const gain = MOVE_GAIN + Math.min(2.4, speed * 1.3);
    s.last = { x: e.clientX, y: e.clientY, t: now };
    s.dx += ddx * gain; s.dy += ddy * gain;
    if (s.moved >= TAP_PX) clearTimeout(s.hold);
    schedule();
  };
  const up = (e) => {
    const s = st.current;
    if (!s.pts.has(e.pointerId)) return;
    s.pts.delete(e.pointerId);
    const dur = performance.now() - s.t0;
    if (s.pts.size === 0) {
      clearTimeout(s.hold);
      if (s.dragging) { push({ t: 'up', b: 'left' }); s.dragging = false; }
      else if (s.moved < TAP_PX * (s.maxPtrs > 1 ? 2 : 1) && dur < TAP_MS) {
        tick();
        push({ t: 'click', b: s.maxPtrs > 1 ? 'right' : 'left' });
      }
      s.maxPtrs = 0;
    }
  };

  return (
    <div className="pc-pad" role="application" aria-label="Touchpad for the computer"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="pc-pad-hint">Drag to move · tap to click · two fingers: tap = right click, drag = scroll · hold to drag</span>
    </div>
  );
}

function PadSheet({ open, onClose, status, refresh }) {
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const noteT = useRef(0);
  const say = (m) => { setNote(m); clearTimeout(noteT.current); noteT.current = setTimeout(() => setNote(''), 4000); };
  const send = useCallback(async (body) => {
    try {
      const r = await call('POST', '/api/pc/input', body);
      if (r.status === 409) say('PC mode is off. Start a stream or turn PC mode on.');
      else if (r.status === 429) say('Slow down a little.');
      else if (r.status >= 400) say(r.error || 'The computer said no.');
      else if (r.ok_all === false) say('Windows blocked that (a secure screen may be up).');
    } catch (e) { say('Can’t reach the computer.'); }
  }, []);
  const key = (k) => { tick(); send({ t: 'key', k }); };
  const hot = (k) => { tick(); send({ t: 'hotkey', k }); };
  const click = (b) => { tick(); send({ t: 'click', b }); };
  const submit = (e) => { e.preventDefault(); if (!typed) return; tick(); send({ t: 'text', s: typed }); setTyped(''); };

  const can = status?.can_input;
  return (
    <div className={`sheet-layer ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="scrim" onClick={onClose} />
      <div className="sheet pc-sheet" role="dialog" aria-modal="true" aria-label="Touchpad">
        <div className="grabber" />
        <header className="sheet-head">
          <h2>Computer touchpad</h2>
          <button className="round glass small" aria-label="Close" onClick={onClose}><Ic.Close size={18} /></button>
        </header>
        {!can && (
          <p className="more-note pc-warn">
            PC mode is off because no stream is running. Start Vidbox or Desktop, or{' '}
            <button className="link" onClick={() => call('POST', '/api/pc/mode', { on: true, minutes: 30 }).then(refresh)}>turn PC mode on for 30 minutes</button>.
          </p>
        )}
        <Touchpad send={send} />
        <div className="row pc-row">
          <button className="pill glass" onClick={() => click('left')}>Left click</button>
          <button className="pill glass" onClick={() => click('right')}>Right click</button>
        </div>
        <form className="ask-field glass" onSubmit={submit}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type on the computer…" enterKeyHint="send"
            autoCapitalize="none" autoCorrect="off" spellCheck="false" aria-label="Type on the computer" />
          <button type="submit" className="round solid small" aria-label="Send to computer" disabled={!typed}><Ic.Send size={18} /></button>
        </form>
        <div className="pc-keys">
          {[['Enter', 'enter'], ['⌫', 'backspace'], ['Tab', 'tab'], ['Esc', 'esc']].map(([l, k]) => (
            <button key={k} className="pill glass" onClick={() => key(k)}>{l}</button>
          ))}
        </div>
        <div className="pc-arrows">
          <span /><button className="pill glass" aria-label="Up" onClick={() => key('up')}>↑</button><span />
          <button className="pill glass" aria-label="Left" onClick={() => key('left')}>←</button>
          <button className="pill glass" aria-label="Down" onClick={() => key('down')}>↓</button>
          <button className="pill glass" aria-label="Right" onClick={() => key('right')}>→</button>
        </div>
        <div className="pc-keys">
          <button className="pill glass" onClick={() => key('space')}>Play / pause</button>
          <button className="pill glass" onClick={() => key('f')}>Fullscreen (F)</button>
          <button className="pill glass" onClick={() => hot(['ctrl', 'l'])}>Address bar</button>
          <button className="pill glass" onClick={() => hot(['alt', 'left'])}>Back</button>
        </div>
        {note && <p className="pc-note" role="status">{note}</p>}
      </div>
    </div>
  );
}

export function PcModeBlock({ open }) {
  const [status, setStatus] = useState(null);
  const [pad, setPad] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const refresh = useCallback(() => call('GET', '/api/pc/status').then((j) => setStatus(j.status && j.status >= 400 ? null : j), () => setStatus(null)), []);
  useEffect(() => {
    if (!open && !pad) return undefined;
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [open, pad, refresh]);

  const start = async (app) => {
    tick(); setBusy(app); setMsg('');
    try {
      const r = await call('POST', '/api/pc/stream', { app, action: 'start' });
      if (r.status >= 400) setMsg(r.error || 'Couldn’t start the stream.');
      else { setMsg(`Starting ${app} on the TV…`); setPad(true); }
    } catch (e) { setMsg('Can’t reach the computer.'); }
    setBusy(''); refresh();
  };
  const stop = async () => {
    tick(); setBusy('stop'); setMsg('');
    try {
      const r = await call('POST', '/api/pc/stream', { action: 'stop' });
      setMsg(r.status >= 400 ? (r.error || 'Couldn’t stop it.') : 'Stream stopped. The TV is back on Home.');
    } catch (e) { setMsg('Can’t reach the computer.'); }
    setBusy(''); refresh();
  };
  const line = !status ? 'Checking the computer…'
    : !status.sunshine ? 'Sunshine isn’t running on the computer (double-click START-SUNSHINE.cmd).'
    : status.streaming ? 'Streaming to the TV now.'
    : status.mode ? `PC mode is on for about ${Math.ceil(status.mode_left / 60)} more minutes.`
    : 'Ready. Nothing is streaming.';

  // parked feature: the bridge says enabled:false (or has no /api/pc), so show nothing at all
  if (!status || status.enabled === false) return null;

  return (
    <section className="more-block group pc-block">
      <h3><Ic.Screen size={16} /> Computer (stream to the TV)</h3>
      <p className="more-note">{line}</p>
      <div className="row">
        <button className="pill glass" disabled={!!busy || !status?.sunshine} onClick={() => start('Vidbox')}>{busy === 'Vidbox' ? 'Starting…' : 'Vidbox'}</button>
        <button className="pill glass" disabled={!!busy || !status?.sunshine} onClick={() => start('Desktop')}>{busy === 'Desktop' ? 'Starting…' : 'Desktop'}</button>
        <button className="pill glass" disabled={!!busy} onClick={stop}>Stop</button>
      </div>
      <button className="pill glass arrange-open" onClick={() => { tick(); setPad(true); }}><Ic.Pointer size={16} /> Open touchpad</button>
      {msg && <p className="more-note" role="status">{msg}</p>}
      {createPortal(<PadSheet open={pad} onClose={() => setPad(false)} status={status} refresh={refresh} />, document.body)}
    </section>
  );
}
