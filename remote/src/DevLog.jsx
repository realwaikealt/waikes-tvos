import { useEffect, useState } from 'react';
import { Sheet } from './Sheets.jsx';
import { tick } from './haptics.js';

// Phone Dev log: the same list as the TV's Settings > Dev log (/api/devlog). A block in the TV sheet opens this;
// the plain page at /devlog shows the same thing without the app.
const TYPES = { new: 'New', improved: 'Improved', fixed: 'Fixed', security: 'Security', internal: 'Behind the scenes' };
const FILTERS = [['All', null], ['New', 'new'], ['Improved', 'improved'], ['Fixed', 'fixed']];
const parse = (d) => { const p = d.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const clock = (t) => { const [h, m] = t.split(':'); return `${((+h + 11) % 12) + 1}:${m} ${+h < 12 ? 'AM' : 'PM'}`; };
const dayName = (d) => parse(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

async function loadLog() {
  const r = await fetch('/api/devlog', { cache: 'no-store' });
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  return (j.entries || []).slice().sort((a, b) => (a.date + a.time + a.id < b.date + b.time + b.id ? -1 : 1));
}

export function DevLogSheet({ open, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  const [fi, setFi] = useState(0);
  const [openId, setOpenId] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setErr(false);
    loadLog().then((r) => live && setRows(r), () => live && setErr(true));
    return () => { live = false; };
  }, [open]);
  const last = rows?.[rows.length - 1];
  const shown = (rows || []).filter((e) => !FILTERS[fi][1] || e.type === FILTERS[fi][1]).reverse();
  let day = '';
  return (
    <Sheet open={open} onClose={onClose} title="Dev log" className="devlog-sheet">
      {last && <p className="more-note dl-ver">Asher’s tvOS {last.version} · latest update {parse(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, {clock(last.time)}</p>}
      <div className="dl-chips" role="group" aria-label="Filter">
        {FILTERS.map(([label, type], i) => (
          <button key={label} className="dl-chip" aria-pressed={i === fi} onClick={() => { tick(); setFi(i); }}>
            {label}{rows && <i>{rows.filter((e) => !type || e.type === type).length}</i>}
          </button>
        ))}
      </div>
      <div className="dl-scroll">
        {err && <p className="more-note">Can’t load the Dev log. Is your phone on the home Wi-Fi?</p>}
        {!rows && !err && [0, 1, 2].map((n) => <div key={n} className="skeleton dl-sk" />)}
        {rows && !shown.length && <p className="more-note">Nothing here yet.</p>}
        {shown.map((e) => {
          const head = e.date !== day ? (day = e.date, <div className="dl-day">{dayName(e.date)}</div>) : null;
          return (
            <div key={e.id}>
              {head}
              <button className="dl-item" aria-expanded={openId === e.id} onClick={() => { tick(); setOpenId(openId === e.id ? '' : e.id); }}>
                <span className="dl-meta"><span className={`dl-type t-${e.type}`}>{TYPES[e.type] || e.type}</span><span>{clock(e.time)}</span><span className="dl-v">{e.version}</span></span>
                <strong>{e.title}</strong>
                <span className="dl-sum">{e.summary}</span>
                {openId === e.id && e.details?.length > 0 && <ul>{e.details.map((d, n) => <li key={n}>{d}</li>)}</ul>}
              </button>
            </div>
          );
        })}
      </div>
      <p className="more-note"><a className="fine-link" href="/devlog">Open as a page</a></p>
    </Sheet>
  );
}

export function DevLogBlock() {
  const [open, setOpen] = useState(false);
  return (
    <section className="more-block group">
      <h3>Dev log</h3>
      <p className="more-note">What changed on the TV and the remote, with dates and times.</p>
      <button className="fine-link" onClick={() => { tick(); setOpen(true); }}>Open the Dev log</button>
      <DevLogSheet open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
