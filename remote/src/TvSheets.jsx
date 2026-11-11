import { useEffect, useState } from 'react';
import { api } from './api.js';
import { tick } from './haptics.js';
import * as Ic from './icons.jsx';
import { Sheet } from './Sheets.jsx';

// The title of the Remote page opens this: pick which TV this phone drives, and open Health.
export function TvPicker({ open, onClose, tvs, tvId, onTv, onHealth }) {
  return (
    <Sheet open={open} onClose={onClose} title="TVs" className="tv-picker">
      <section className="more-block group list" role="radiogroup" aria-label="Which TV">
        {(tvs || []).map((t) => {
          const tone = t.paired === false ? 'off' : t.connected ? (t.power === 'off' ? 'warn' : 'ok') : 'bad';
          const sub = t.paired === false ? 'Not set up yet' : !t.connected ? 'Not connected' : t.power === 'off' ? 'Screen off' : 'On';
          return (
            <button key={t.id} role="radio" aria-checked={t.id === tvId} className={`list-row tv-row ${t.id === tvId ? 'on' : ''}`}
              onClick={() => { tick(); onTv(t.id); onClose(); }}>
              <span className={`tv-dot ${tone}`} aria-hidden="true" />
              <span className="row-text"><b>{t.name}</b><small>{sub}</small></span>
              {t.id === tvId && <span className="who-tick" aria-hidden="true">&#10003;</span>}
            </button>
          );
        })}
      </section>
      <section className="more-block group list">
        <button className="list-row" onClick={() => { tick(); onClose(); setTimeout(onHealth, 220); }}>
          <span className="row-icon"><Ic.Pulse size={20} /></span>
          <span className="row-text"><b>Health</b><small>Connection, speed and home screen for every TV</small></span>
          <Ic.Chevron className="row-chev" />
        </button>
      </section>
    </Sheet>
  );
}

const TONE = { fast: 'ok', ok: 'warn', slow: 'bad' };
const SPEED = { fast: 'Fast', ok: 'Fine', slow: 'Slow' };
const dur = (s) => { const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };

function HealthCard({ t }) {
  const link = t.link || {};
  const tone = !t.paired ? 'off' : t.connected ? 'ok' : 'bad';
  const state = !t.paired ? 'Not set up yet' : t.connected ? (t.power === 'off' ? 'Connected, screen off' : 'Connected') : 'Not connected';
  const home = t.home || {};
  return (
    <section className="more-block group health-card">
      <div className="hc-head"><span className={`tv-dot ${tone}`} aria-hidden="true" /><div><b>{t.name}</b><small>{state}</small></div></div>
      <dl>
        <div><dt>Speed to the TV</dt><dd className={link.ok ? TONE[link.rating] : 'off'}>{link.ok ? `${link.avg_ms} ms` : 'No answer'}{link.ok && <small>{SPEED[link.rating]}{link.lost ? ` · ${link.lost} of 3 dropped` : ''}</small>}</dd></div>
        <div><dt>Default home</dt><dd className={home.id === 'ours' ? 'ok' : ''}>{home.known ? home.name : 'Not known'}{!home.known && !t.connected && <small>Needs the TV on</small>}</dd></div>
        <div><dt>Home screen open</dt><dd className={t.screen_open ? 'ok' : 'off'}>{t.screen_open ? 'Yes' : 'No'}</dd></div>
        <div><dt>Address</dt><dd>{t.ip || 'Unknown'}</dd></div>
      </dl>
    </section>
  );
}

export function HealthSheet({ open, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let dead = false; let timer = 0;
    const load = () => api.healthAll().then((d) => { if (!dead) { setData(d); setErr(false); } }).catch(() => { if (!dead) setErr(true); })
      .finally(() => { if (!dead) timer = setTimeout(load, 6000); });
    load();
    return () => { dead = true; clearTimeout(timer); };
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="Health" className="health-sheet">
      {err && !data && <p className="more-note" role="status">Can’t reach the bridge. Is your phone on the home Wi-Fi?</p>}
      {!data && !err && <p className="more-note" role="status">Checking…</p>}
      {data && data.tvs.map((t) => <HealthCard key={t.id} t={t} />)}
      {data && <p className="more-note">Bridge up {dur(data.bridge.uptime_s)} · Ask Claude {data.bridge.claude ? 'ready' : 'not available'}</p>}
    </Sheet>
  );
}
