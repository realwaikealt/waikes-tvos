import { useCallback, useEffect, useRef, useState } from 'react';
import * as Ic from './icons.jsx';
import { tick } from './haptics.js';
import { logoFor } from './appLogos.js';
import { api } from './api.js';
import './appshelf.css';

// The TV's apps, in the order the TV home shows them (Smart by default): streaming first, then live TV,
// music, tools and the rest, with the TV's own clutter in a Hidden section. Sort chips pick the order,
// Edit pins an app to the dock or hides it. Nothing is ever turned off on the TV; hiding only changes
// what the TV home and this page show. `fallback` is the plain list used while this cannot load.
const SHORT = { 'HBO Max': 'HBO Max', 'Prime Video': 'Prime Video' };
const CHIP_LABEL = { smart: 'Smart', used: 'Most used', recent: 'Recent', az: 'A–Z', category: 'Groups', manual: 'My order' };

function Tile({ it, edit, manual, onOpen, onPin, onHide, onHold }) {
  const timer = useRef(null);
  const held = useRef(false);
  const down = () => {
    held.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { held.current = true; onHold(); }, 520);
  };
  const up = () => clearTimeout(timer.current);
  const logo = logoFor(it);
  return (
    <div className={`as-tile ${it.hidden ? 'is-hidden' : ''} ${edit ? 'editing' : ''}`}>
      <button className="app-tile as-open" onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (held.current) { held.current = false; return; } if (!edit) { tick(); onOpen(it); } }}>
        <span className="app-icon">{logo ? <img src={logo} alt="" /> : <span className="app-icon-name">{it.name}</span>}</span>
        <span className="app-label">{SHORT[it.name] || it.name}</span>
      </button>
      {it.pinned && !edit && <i className="as-pin" aria-label="On the dock"><Ic.Pin size={11} /></i>}
      {edit && !manual && (
        <>
          {!it.hidden && <button className={`as-badge as-pinbtn ${it.pinned ? 'on' : ''}`} aria-label={it.pinned ? `Unpin ${it.name}` : `Pin ${it.name} to the dock`} onClick={() => { tick(); onPin(it); }}><Ic.Pin size={14} /></button>}
          <button className="as-badge as-hidebtn" aria-label={it.hidden ? `Show ${it.name}` : `Hide ${it.name}`} onClick={() => { tick(); onHide(it); }}>{it.hidden ? <Ic.Eye size={14} /> : <Ic.EyeOff size={14} />}</button>
        </>
      )}
    </div>
  );
}

export function AppShelf({ onLaunch, fallback, tvId }) {
  const [view, setView] = useState(null);     // what /api/arrange answered, or false
  const [edit, setEdit] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [note, setNote] = useState('');
  const chips = useRef(null);

  const load = useCallback(() => api.arrange().then(setView).catch(() => setView((v) => v || false)), []);
  useEffect(() => { load(); }, [load, tvId]);
  useEffect(() => { const f = () => load(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [load]);

  if (view === null) return <div className="apps" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="app-tile"><span className="app-icon skeleton" /><span className="app-label skeleton sk-line short" /></div>)}</div>;
  if (!view || !view.items?.length) return fallback;

  const send = (body, msg) => api.arrangeSet(body).then((v) => { setView(v); if (msg) setNote(msg); }).catch((e) => setNote(e.message));
  const manual = view.mode === 'manual';
  const shown = view.items.filter((i) => !i.hidden);
  const hidden = view.items.filter((i) => i.hidden);
  const labels = Object.fromEntries((view.categories || []).map((c) => [c.id, c.label]));
  const open = (it) => onLaunch({ id: it.package, name: it.name, package: it.package });
  const tile = (it) => (
    <Tile key={it.package} it={it} edit={edit} manual={manual} onOpen={open}
      onHold={() => { if (!manual) { tick(); setEdit(true); } }}
      onPin={(a) => send({ pin: a.package, on: !a.pinned }, a.pinned ? `${a.name} unpinned.` : `${a.name} is first on the TV's dock.`)}
      onHide={(a) => send({ hide: a.package, on: !a.hidden }, a.hidden ? `${a.name} is back.` : `${a.name} is hidden. It is still on the TV.`)} />
  );

  // the apps in groups, in the order of the list
  const groups = [];
  if (view.headers) {
    shown.forEach((it) => {
      const last = groups[groups.length - 1];
      if (last && last.id === it.group) last.items.push(it); else groups.push({ id: it.group, items: [it] });
    });
  }

  return (
    <div className="as" data-mode={view.mode}>
      <div className="as-chips" role="tablist" aria-label="Sort apps" ref={chips}>
        {(view.modes || []).map((m) => (
          <button key={m.id} role="tab" aria-selected={view.mode === m.id} className={`chip as-chip ${view.mode === m.id ? 'on' : ''}`}
            onClick={() => { tick(); send({ prefs: { mode: m.id } }, m.id === 'manual' ? 'Your own order. Arrange it from More.' : ''); }}>
            {CHIP_LABEL[m.id] || m.label}
          </button>
        ))}
      </div>
      <div className="as-bar">
        {!manual ? (
          <button className={`chip as-chip small ${view.headers ? 'on' : ''}`} onClick={() => { tick(); send({ prefs: { group: !view.prefs.group } }); }}>Group headings</button>
        ) : <span className="as-note">Your own order. Pins and hiding work in the other orders.</span>}
        {!manual && <button className={`chip as-chip small ${edit ? 'on' : ''}`} onClick={() => { tick(); setEdit(!edit); setNote(''); }}>{edit ? 'Done' : 'Edit'}</button>}
      </div>

      {view.headers ? groups.map((g) => (
        <div key={g.id} className="as-group">
          <h4>{labels[g.id] || g.id}</h4>
          <div className="apps">{g.items.map(tile)}</div>
        </div>
      )) : <div className="apps">{shown.map(tile)}</div>}

      {hidden.length > 0 && !manual && (
        <div className="as-hidden">
          <button className="row-btn cell" aria-expanded={hiddenOpen} onClick={() => { tick(); setHiddenOpen(!hiddenOpen); }}>
            <span className="row-icon"><Ic.EyeOff /></span>
            <span className="row-text"><b>Hidden apps ({hidden.length})</b><small>The TV's own tools. Still installed; tap Edit to bring one back.</small></span>
            <Ic.Chevron className="row-chev" style={{ transform: hiddenOpen ? 'none' : 'rotate(180deg)' }} />
          </button>
          {hiddenOpen && <div className="apps as-hidden-grid">{hidden.map(tile)}</div>}
        </div>
      )}
      {note && <p className="note as-msg" role="status">{note}</p>}
    </div>
  );
}
