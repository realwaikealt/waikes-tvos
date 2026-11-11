import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sheet } from './Sheets.jsx';
import { tick } from './haptics.js';

// Phone Dev log: the same list as the TV's Settings > Dev log (/api/devlog). A block in the TV sheet opens this;
// the plain page at /devlog shows the same thing without the app.
const TYPES = { new: 'New', improved: 'Improved', fixed: 'Fixed', security: 'Security', internal: 'Behind the scenes' };
const FILTERS = [['All', null], ['New', 'new'], ['Improved', 'improved'], ['Fixed', 'fixed'], ['Status', 'status']];
const STATUS = { test: 'Needs testing', work: 'Unfinished', todo: 'Not started', idea: 'Just an idea', parked: 'Saved for later', done: 'Completed' };
const STATUS_ORDER = ['test', 'work', 'todo', 'idea', 'parked', 'done'];
// Short bullet points for the list: the entry's own bullets, else its summary split into sentences.
const bulletsOf = (e) => (e.bullets && e.bullets.length ? e.bullets : (String(e.summary || '').match(/[^.!?]+[.!?]*/g) || []).map((t) => t.trim()).filter(Boolean).slice(0, 3));
const parse = (d) => { const p = d.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const clock = (t) => { const [h, m] = t.split(':'); return `${((+h + 11) % 12) + 1}:${m} ${+h < 12 ? 'AM' : 'PM'}`; };
const dayName = (d) => parse(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

async function loadLog() {
  const r = await fetch('/api/devlog', { cache: 'no-store' });
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  const entries = (j.entries || []).slice().sort((a, b) => (a.date + a.time + a.id < b.date + b.time + b.id ? -1 : 1));
  return { entries, board: (j.board || []).slice().sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)) };
}

export function DevLogSheet({ open, onClose }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState(false);
  const [fi, setFi] = useState(0);
  const [openId, setOpenId] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setErr(false); setSel(null);
    loadLog().then((r) => live && setData(r), () => live && setErr(true));
    return () => { live = false; };
  }, [open]);
  const rows = data?.entries || null;
  const isBoard = FILTERS[fi][1] === 'status';
  const last = rows?.[rows.length - 1];
  const shown = isBoard ? (data?.board || []) : (rows || []).filter((e) => !FILTERS[fi][1] || e.type === FILTERS[fi][1]).reverse();
  let day = '';
  return (
    <Sheet open={open} onClose={onClose} title="Dev log" className="devlog-sheet" portal>
      {last && <p className="more-note dl-ver">Asher’s tvOS {last.version} · latest update {parse(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, {clock(last.time)}</p>}
      <div className="dl-chips" role="group" aria-label="Filter">
        {FILTERS.map(([label, type], i) => (
          <button key={label} className="dl-chip" aria-pressed={i === fi} onClick={() => { tick(); setFi(i); }}>
            {label}{rows && <i>{type === 'status' ? (data.board || []).length : rows.filter((e) => !type || e.type === type).length}</i>}
          </button>
        ))}
      </div>
      <div className="dl-scroll">
        {err && <p className="more-note">Can’t load the Dev log. Is your phone on the home Wi-Fi?</p>}
        {!rows && !err && [0, 1, 2].map((n) => <div key={n} className="skeleton dl-sk" />)}
        {rows && !shown.length && <p className="more-note">Nothing here yet.</p>}
        {shown.map((e) => {
          const g = isBoard ? e.status : e.date;
          const head = g !== day ? (day = g, <div className="dl-day">{isBoard ? STATUS[g] || g : dayName(e.date)}</div>) : null;
          return (
            <div key={e.id}>
              {head}
              <button className="dl-item" onClick={() => { tick(); setSel(e); }}>
                <span className="dl-meta">
                  {isBoard ? <span className={`dl-type s-${e.status}`}>{STATUS[e.status] || e.status}</span>
                    : <><span className={`dl-type t-${e.type}`}>{TYPES[e.type] || e.type}</span><span>{clock(e.time)}</span><span className="dl-v">{e.version}</span></>}
                </span>
                <strong>{e.title}</strong>
                <ul className="dl-bul">{bulletsOf(e).map((b, n) => <li key={n}>{b}</li>)}</ul>
                {e.details?.length > 0 && <span className="dl-more">Tap for the full story ›</span>}
              </button>
            </div>
          );
        })}
      </div>
      <p className="more-note"><a className="fine-link" href="/devlog">Open as a page</a></p>
      {sel && createPortal(
        <div className="dl-pop" role="dialog" aria-label={sel.title} onClick={() => setSel(null)}>
          <div className="dl-card" onClick={(ev) => ev.stopPropagation()}>
            <span className="dl-meta">
              {sel.status ? <span className={`dl-type s-${sel.status}`}>{STATUS[sel.status] || sel.status}</span>
                : <><span className={`dl-type t-${sel.type}`}>{TYPES[sel.type] || sel.type}</span><span>{dayName(sel.date)}, {clock(sel.time)}</span><span className="dl-v">{sel.version}</span></>}
            </span>
            <h3>{sel.title}</h3>
            <p className="dl-msum">{sel.summary}</p>
            {sel.details?.length > 0 && <><div className="dl-mhead">In depth</div><ul className="dl-mdet">{sel.details.map((d, n) => <li key={n}>{d}</li>)}</ul></>}
            <button className="dl-close" onClick={() => { tick(); setSel(null); }}>Close</button>
          </div>
        </div>,
        document.body
      )}
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
