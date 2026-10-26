import { forwardRef, useEffect, useRef, useState } from 'react';
import * as Ic from './icons.jsx';
import { usePushUp } from './gestures.js';
import { tick } from './haptics.js';
import { api } from './api.js';
import { logoFor } from './appLogos.js';

export const Sheet = forwardRef(function Sheet({ open, onClose, title, children, className = '', fromTop = false, closeDrag, extra = null }, ref) {
  return (
    <div className={`sheet-layer ${open ? 'open' : ''} ${fromTop ? 'from-top' : ''}`} aria-hidden={!open} inert={!open}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="scrim" onClick={onClose} />
      <div ref={ref} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {!fromTop && <div className="grabber" />}
        <header className="sheet-head">
          <h2>{title}</h2>
          {extra}
          <button className="round glass small" aria-label="Close" onClick={onClose}><Ic.Close size={18} /></button>
        </header>
        {children}
        {fromTop && <div className="grabber-zone" {...closeDrag}><div className="grabber" /></div>}
      </div>
    </div>
  );
});

const Speech = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const canListen = Boolean(Speech) && typeof window !== 'undefined' && window.isSecureContext;

// Ask is a short conversation with Claude: his words on the right, Claude's on the left, and up to
// three quick replies under Claude's latest answer ("Yes, play it"). A quick reply is sent as his
// next message. The thread lasts for the session and is cleared after 15 minutes without a message,
// the same as the bridge's own memory of the conversation. "New chat" clears it straight away.
// The input sits at the bottom, just above the keyboard, and is always mounted so the tap on "Ask"
// can focus it straight away (iOS only raises the keyboard when focus happens inside the tap).
const THREAD_KEY = 'tv.askThread';
const IDLE_MS = 15 * 60000;
const loadThread = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(THREAD_KEY) || 'null');
    return t && Date.now() - t.at < IDLE_MS ? t.items.filter((m) => !m.pending) : [];
  } catch { return []; }
};
const saveThread = (items) => { try { sessionStorage.setItem(THREAD_KEY, JSON.stringify({ at: Date.now(), items })); } catch { /* private mode */ } };
const friendly = (msg) => (msg === 'Can’t reach the bridge' ? 'Can’t reach the TV. Is your phone on the home Wi-Fi?' : msg);

export const AskSheet = forwardRef(function AskSheet({ open, onClose, recs, onAsk, onDone }, inputRef) {
  const [text, setText] = useState('');
  const [thread, setThread] = useState(loadThread);
  const [secs, setSecs] = useState(0);
  const [listening, setListening] = useState(false);
  const rec = useRef(null);
  const chat = useRef(0);          // bumps on New chat, so a late answer to the old chat is dropped
  const closeT = useRef(null);
  const lastAt = useRef(Date.now());
  const list = useRef(null);
  const busy = thread.some((m) => m.pending);
  // Speaking through the keyboard's microphone: the words arrive in bursts, not a letter at a time.
  // After a burst, once the text has been still for 1.5 s, a 2 s countdown shows and then it sends.
  // Typing a key, or tapping the countdown, stops it. Typed text always waits for Send.
  const [countdown, setCountdown] = useState(0);
  const burst = useRef(false);
  const idleT = useRef(null);
  const cdT = useRef(null);
  const textNow = useRef('');
  textNow.current = text;
  const cancelAuto = () => { clearTimeout(idleT.current); clearInterval(cdT.current); setCountdown(0); };
  useEffect(() => () => { cancelAuto(); clearTimeout(closeT.current); }, []);

  useEffect(() => { saveThread(thread); }, [thread]);
  useEffect(() => {
    clearTimeout(closeT.current);
    cancelAuto(); burst.current = false;
    if (open) {
      setText('');
      if (Date.now() - lastAt.current > IDLE_MS && !busy) setThread([]);   // 15 minutes quiet: start fresh
    } else { rec.current?.abort?.(); setListening(false); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!busy) return undefined;
    setSecs(0);
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  // Keep the newest message and its quick replies in view, also when the keyboard makes room smaller.
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [thread]);
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [thread.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (q) => {
    const ask = (q ?? textNow.current).trim();
    cancelAuto(); burst.current = false;
    if (!ask || busy) return;
    inputRef.current?.blur();
    clearTimeout(closeT.current);
    const c = chat.current;
    const id = `${Date.now()}`;
    lastAt.current = Date.now();
    setText('');
    setThread((t) => [...t.map((m) => ({ ...m, options: [] })), { id: `${id}-me`, me: true, text: ask }, { id, pending: true }]);
    let reply;
    try {
      const r = await onAsk(ask);
      reply = { text: r.say || r.reply || 'Done.', options: (Array.isArray(r.options) ? r.options : []).filter((o) => o && o.text).slice(0, 3), still: /^Still working on it/.test(r.reply || '') };
      if (c === chat.current) {
        tick();
        // A plain "done it" with nothing to choose closes by itself, as before; the answer stays as a toast.
        if ((r.actions || []).some((a) => a.ok) && !reply.options.length && !reply.still) {
          closeT.current = setTimeout(() => { if (c === chat.current) { onDone?.(reply.text); onClose(); } }, 2600);
        }
      }
    } catch (e) {
      reply = { text: friendly(e.message), err: true, options: [{ label: 'Try again', text: ask }] };
    }
    if (c !== chat.current) return;
    lastAt.current = Date.now();
    setThread((t) => t.map((m) => (m.id === id ? { id, ...reply } : m)));
  };
  const newChat = () => { tick(); chat.current += 1; clearTimeout(closeT.current); setThread([]); setText(''); inputRef.current?.focus(); };

  const startCountdown = () => {
    let left = 2;
    setCountdown(left);
    clearInterval(cdT.current);
    cdT.current = setInterval(() => {
      left -= 1;
      if (left > 0) setCountdown(left);
      else { clearInterval(cdT.current); setCountdown(0); submit(); }
    }, 1000);
  };
  const onType = (e) => {
    const v = e.target.value;
    if (v.length - textNow.current.length >= 4) burst.current = true;
    setText(v);
    cancelAuto();
    clearTimeout(closeT.current);
    if (burst.current && v.trim() && !busy) idleT.current = setTimeout(startCountdown, 1500);
  };
  // A real key press means typing: no auto send.
  const onKey = (e) => { if (e.key && e.key.length === 1) { burst.current = false; cancelAuto(); } };

  const listen = () => {
    tick();
    if (listening) { rec.current?.stop(); return; }
    const r = new Speech();
    r.lang = 'en-AU'; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0].transcript).join(''); setText(t); if (e.results[e.results.length - 1].isFinal) { r.stop(); submit(t); } };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };

  const first = recs?.continue?.[0]?.title;
  const ideas = [
    first ? `Keep watching ${first}` : 'Put on Bluey',
    'Recommend something for tonight',
    'Something funny, under an hour',
    'What’s new on Stan?',
  ];
  const last = thread[thread.length - 1];
  const chips = last && !last.me && !last.pending ? last.options || [] : [];

  return (
    <Sheet open={open} onClose={onClose} title="Ask for a show" className="ask-sheet"
      extra={thread.length > 0 && <button type="button" className="pill glass new-chat" onClick={newChat}>New chat</button>}>
      {thread.length > 0 ? (
        <div className="thread" ref={list} role="log" aria-live="polite" aria-label="Conversation with Claude">
          {thread.map((m) => (m.me ? (
            <p key={m.id} className="bubble me"><span className="sr-only">You said: </span>{m.text}</p>
          ) : m.pending ? (
            <div key={m.id} className="bubble claude pending" role="status">
              <span className="sr-only">Claude is working on it.</span>
              <span className="dots" aria-hidden="true"><i /><i /><i /></span>
              <small>Claude is finding it{secs > 3 ? ` · ${secs}s` : ''}. Usually 5 to 20 seconds.</small>
            </div>
          ) : (
            <p key={m.id} className={`bubble claude ${m.err ? 'err' : ''}`}><span className="sr-only">Claude: </span>{m.text}
              {m.still && <small>It carries on by itself. Watch the TV.</small>}</p>
          )))}
          {chips.length > 0 && (
            <div className="replies" aria-label="Quick replies">
              {chips.map((o) => (
                <button key={o.text} type="button" className="chip glass reply-chip" onClick={() => { tick(); submit(o.text); }}>{o.label || o.text}</button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="ideas" aria-label="Ideas">
          {ideas.map((i) => <button key={i} type="button" className="chip glass" onClick={() => { tick(); submit(i); }}>{i}</button>)}
        </div>
      )}
      <form className="ask-field glass" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input ref={inputRef} value={text} onChange={onType} onKeyDown={onKey} enterKeyHint="send"
          placeholder={thread.length ? 'Reply…' : 'Put on…'} aria-label={thread.length ? 'Reply to Claude' : 'What do you want to watch?'} autoComplete="off" autoCorrect="on" />
        {canListen && <button type="button" className={`round glass ask-mic ${listening ? 'listening' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak'}
          onPointerDown={(e) => e.preventDefault()} onClick={listen}><Ic.Mic size={20} /></button>}
        <button type="submit" className="round solid ask-send" aria-label="Send" disabled={!text.trim() || busy}
          onPointerDown={(e) => e.preventDefault()}><Ic.Send size={20} /></button>
      </form>
      {countdown > 0 && (
        <button type="button" className="autosend" aria-live="polite" onPointerDown={(e) => e.preventDefault()}
          onClick={() => { tick(); burst.current = false; cancelAuto(); }}>
          <span className="autosend-bar" key={text} />
          <span>Sending in {countdown} s</span><b>Keep editing</b>
        </button>
      )}
      {!canListen && countdown === 0 && thread.length === 0 && (
        <p className="tip talk-tip"><span className="talk-mic"><Ic.Mic size={18} /></span>
          <span><b>Tap the mic on your keyboard and speak.</b> It sends by itself when you stop.</span></p>
      )}
    </Sheet>
  );
});

const SLEEP = [0, 15, 30, 45, 60, 90];

// Arrange apps: drag an app by its handle; the "More apps" line splits what the TV's dock
// shows from what sits behind More apps. Saves on letting go. The TV picks it up on its next Home.
const LINE = '__line__';
export function ArrangeSheet({ open, onClose, tvName }) {
  const [rows, setRows] = useState(null);   // packages and the LINE marker, in order
  const [names, setNames] = useState({});
  const [max, setMax] = useState(10);
  const [msg, setMsg] = useState('');
  const [drag, setDrag] = useState(null);   // the package being dragged
  const list = useRef(null);
  const sheet = useRef(null);

  useEffect(() => {
    if (!open) return;
    setRows(null); setMsg('');
    api.appOrder().then((d) => {
      const pk = (d.apps || []).map((a) => a.package);
      setNames(Object.fromEntries((d.apps || []).map((a) => [a.package, a.name])));
      setMax(d.dock_max || 10);
      setRows(pk.length ? [...pk.slice(0, d.line), LINE, ...pk.slice(d.line)] : []);
    }).catch((e) => { setRows([]); setMsg(e.message); });
  }, [open]);

  const save = (next) => {
    let r = next;
    let at = r.indexOf(LINE);
    if (at > max) {   // the dock is full: the line moves up to just under the last dock app
      r = r.filter((p) => p !== LINE); r.splice(max, 0, LINE); at = max;
      setRows(r);
      setMsg(`The dock holds ${max} apps, so the ones under it moved behind More apps.`);
    } else setMsg('Saved. Press Home on the TV to see it.');
    api.saveAppOrder(r.filter((p) => p !== LINE), at).catch((e) => setMsg(e.message));
  };

  const start = (e, p) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    tick();
    setDrag(p);
  };
  const move = (e) => {
    if (!drag || !list.current) return;
    const box = list.current.getBoundingClientRect();
    const first = list.current.firstElementChild;
    const rowH = first ? first.getBoundingClientRect().height + 6 : 66;
    const to = Math.max(0, Math.min(rows.length - 1, Math.floor((e.clientY - box.top) / rowH)));
    const from = rows.indexOf(drag);
    if (to !== from) {
      const r = rows.slice(); r.splice(from, 1); r.splice(to, 0, drag); setRows(r);
    }
    const s = sheet.current?.getBoundingClientRect();   // near the sheet's edge: scroll it
    if (s && e.clientY < s.top + 70) sheet.current.scrollTop -= 14;
    else if (s && e.clientY > s.bottom - 70) sheet.current.scrollTop += 14;
  };
  const end = () => { if (drag) { setDrag(null); save(rows); } };

  return (
    <Sheet ref={sheet} open={open} onClose={onClose} title="Arrange apps" className="arrange-sheet">
      <p className="note arrange-lede">{tvName ? `${tvName}. ` : ''}Drag an app by its handle. Apps above the line are in the TV's dock (up to {max}); the rest are behind More apps. Settings is always last.</p>
      {rows === null && <p className="note">Loading the TV's apps…</p>}
      {rows && rows.length === 0 && !msg && <p className="note">This TV has not told the bridge its apps yet. Press Home on the TV, then open this again.</p>}
      <ol className="arrange" ref={list} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        {(rows || []).map((p, i) => p === LINE ? (
          <li key={LINE} className={`arrange-line ${drag === LINE ? 'lifted' : ''}`}>
            <span>More apps</span>
            <button className="grip" aria-label="Move the More apps line" onPointerDown={(e) => start(e, LINE)}><Ic.Grip size={20} /></button>
          </li>
        ) : (
          <li key={p} className={`arrange-row glass ${drag === p ? 'lifted' : ''} ${i > rows.indexOf(LINE) ? 'below' : ''}`}>
            {logoFor({ package: p }) ? <img src={logoFor({ package: p })} alt="" /> : <span className="arrange-blank">{(names[p] || '?').slice(0, 1)}</span>}
            <b>{names[p] || p}</b>
            <button className="grip" aria-label={`Move ${names[p] || p}`} onPointerDown={(e) => start(e, p)}><Ic.Grip size={20} /></button>
          </li>
        ))}
      </ol>
      {msg && <p className="note arrange-msg" role="status">{msg}</p>}
    </Sheet>
  );
}

// People: the names on the TV's "who is watching" switch and on this remote, in order. Drag by the
// handle to reorder, tap a name to rename it, the cross removes. Every change saves straight away;
// the TV picks it up on its next Home. Colours match the TV's (same palette, same id hash).
const PALETTE = ['#ff9f0a', '#30b350', '#0a84ff', '#bf5af2', '#ff375f', '#00a5a8', '#5e5ce6', '#ac8e68'];
export const personColour = (p) => {
  if (p.colour) return p.colour;
  const id = p.id || '';
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
export function PeopleSheet({ open, onClose, onSaved }) {
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const [drag, setDrag] = useState(null);   // the id being dragged
  const [adding, setAdding] = useState('');
  const list = useRef(null);
  const sheet = useRef(null);

  useEffect(() => {
    if (!open) return;
    setRows(null); setMsg(''); setAdding('');
    api.people().then((d) => setRows(d.people || [])).catch((e) => { setRows([]); setMsg(e.message); });
  }, [open]);

  const save = (next, done) => {
    // someone new has no id until the bridge gives one, so they show once it answers
    if (next.every((p) => p.id)) setRows(next);
    api.savePeople(next).then((d) => { setRows(d.people); onSaved?.(d.people); setMsg(done || 'Saved. Press Home on the TV to see it.'); })
      .catch((e) => setMsg(e.message));
  };
  const rename = (id, name) => {
    const clean = name.replace(/\s+/g, ' ').trim();
    const was = rows.find((p) => p.id === id);
    if (!clean || !was || clean === was.name) { setRows(rows.slice()); return; }
    save(rows.map((p) => (p.id === id ? { ...p, name: clean } : p)));
  };
  const remove = (p) => { tick(); save(rows.filter((x) => x.id !== p.id), `Removed ${p.name}. Their watch history stays on the bridge.`); };
  const add = (e) => {
    e.preventDefault();
    const name = adding.replace(/\s+/g, ' ').trim();
    if (!name) return;
    tick(); setAdding('');
    save([...(rows || []), { name }], `Added ${name}.`);
  };

  const start = (e, id) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); tick(); setDrag(id); };
  const move = (e) => {
    if (!drag || !list.current) return;
    const box = list.current.getBoundingClientRect();
    const first = list.current.firstElementChild;
    const rowH = first ? first.getBoundingClientRect().height + 6 : 66;
    const to = Math.max(0, Math.min(rows.length - 1, Math.floor((e.clientY - box.top) / rowH)));
    const from = rows.findIndex((p) => p.id === drag);
    if (to !== from) { const r = rows.slice(); const [it] = r.splice(from, 1); r.splice(to, 0, it); setRows(r); }
  };
  const end = () => { if (drag) { setDrag(null); save(rows); } };

  return (
    <Sheet ref={sheet} open={open} onClose={onClose} title="People" className="arrange-sheet people-sheet">
      <p className="note arrange-lede">In the order the TV shows them. Drag the handle to move someone, tap a name to change it.</p>
      {rows === null && <p className="note">Loading…</p>}
      {rows && rows.length === 0 && <p className="note">Nobody yet. The TV shows everything until you add someone.</p>}
      <ol className="arrange" ref={list} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        {(rows || []).map((p) => (
          <li key={p.id} className={`arrange-row glass ${drag === p.id ? 'lifted' : ''}`}>
            <span className="person-dot" style={{ background: personColour(p) }}>{p.name.slice(0, 1).toUpperCase()}</span>
            <input className="person-name" defaultValue={p.name} key={p.name} maxLength={40} aria-label={`Name for ${p.name}`}
              enterKeyHint="done" onBlur={(e) => rename(p.id, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <button className="person-remove" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}><Ic.Close size={18} /></button>
            <button className="grip" aria-label={`Move ${p.name}`} onPointerDown={(e) => start(e, p.id)}><Ic.Grip size={20} /></button>
          </li>
        ))}
      </ol>
      {rows && rows.length < 12 && (
        <form className="ask-field glass person-add" onSubmit={add}>
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a person" maxLength={40} enterKeyHint="done" aria-label="New person's name" />
          <button type="submit" className="round solid small" aria-label="Add" disabled={!adding.trim()}><Ic.Plus size={18} /></button>
        </form>
      )}
      {msg && <p className="note arrange-msg" role="status">{msg}</p>}
    </Sheet>
  );
}

export const MoreSheet = forwardRef(function MoreSheet({ open, onClose, sleepEnds, onSleep, onKey, onText, sleepError, tvs, tvId, onTv, picture, pictureInfo, onPicture, onArrange, onPeople }, ref) {
  const [typed, setTyped] = useState('');
  const sheetEl = useRef(null);
  const setRefs = (el) => { sheetEl.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; };
  const closeDrag = usePushUp(sheetEl, onClose);
  const endsAt = sleepEnds ? new Date(sleepEnds) : null;
  const left = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 60000)) : 0;
  return (
    <Sheet ref={setRefs} open={open} onClose={onClose} title="TV" fromTop closeDrag={closeDrag} className="more-sheet">
      {tvs?.length > 1 && (
        <section className="more-block first">
          <h3><Ic.Screen size={16} /> Which TV</h3>
          <div className="chips-row" role="radiogroup" aria-label="Which TV">
            {tvs.map((t) => (
              <button key={t.id} role="radio" aria-checked={t.id === tvId} className={`chip glass ${t.id === tvId ? 'on' : ''}`} onClick={() => onTv(t.id)}>
                {t.name}{t.paired === false ? ' (not set up)' : ''}
              </button>
            ))}
          </div>
        </section>
      )}

      {tvs?.find((t) => t.id === tvId)?.picture && (
        <section className="more-block">
          <h3><Ic.Sparkle size={16} /> Picture</h3>
          <div className="chips-row" role="radiogroup" aria-label="Picture mode">
            {(pictureInfo?.modes?.length ? pictureInfo.modes.map((x) => [x.id, x.name]) : [['calibrated', 'Calibrated'], ['dynamic', 'Dynamic']]).map(([m, label]) => {
              const cur = pictureInfo?.mode ?? picture;
              return (
                <button key={m} role="radio" aria-checked={cur === m} disabled={!pictureInfo?.can_set}
                  className={`chip glass ${cur === m ? 'on' : ''}`} onClick={() => { tick(); onPicture(m); }}>{label}</button>
              );
            })}
          </div>
          {!pictureInfo?.can_set && <p className="note">Picture mode works once this TV is set up.</p>}
        </section>
      )}

      <section className={`more-block ${tvs?.length > 1 ? '' : 'first'}`}>
        <h3><Ic.Moon size={16} /> Sleep timer</h3>
        <div className="chips-row">
          {SLEEP.map((m) => (
            <button key={m} className={`chip glass ${(m === 0 && !endsAt) ? 'on' : ''}`} onClick={() => { tick(); onSleep(m); }}>{m ? `${m} min` : 'Off'}</button>
          ))}
        </div>
        <p className="note">{sleepError || (endsAt ? `The TV turns off at ${endsAt.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })} (${left} min).` : 'Turns the TV off for you, even if your phone is locked.')}</p>
      </section>

      <section className="more-block">
        <h3><Ic.Keyboard size={16} /> Type on the TV</h3>
        <form className="ask-field glass" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { tick(); onText(typed.trim()); setTyped(''); } }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="For a search box on the TV" enterKeyHint="send" aria-label="Text to type on the TV" />
          <button type="submit" className="round solid small" aria-label="Send to TV" disabled={!typed.trim()}><Ic.Send size={18} /></button>
        </form>
      </section>

      <div className="more-grid">
        <button className="tile glass" onClick={() => { tick(); onKey('captions'); }}><Ic.Captions /> Subtitles</button>
        <button className="tile glass" onClick={() => { tick(); onKey('input'); }}><Ic.Input /> Input</button>
        <button className="tile glass" onClick={() => { tick(); onKey('settings'); }}><Ic.Gear /> Settings</button>
      </div>
      <div className="arrange-pair">
        <button className="pill glass arrange-open" onClick={() => { tick(); onArrange(); }}><Ic.Grid size={18} /> Arrange apps</button>
        <button className="pill glass arrange-open" onClick={() => { tick(); onPeople(); }}><Ic.People size={18} /> People</button>
      </div>
    </Sheet>
  );
});

export function Onboarding({ onPick, standalone, people }) {
  return (
    <div className="onboard">
      <div className="onboard-inner">
        <img className="onboard-icon" src="/icons/icon-192.png" alt="" />
        <h1>Who’s this phone for?</h1>
        <p>“Keep watching” and suggestions follow whoever is watching. You can swap at the top any time.</p>
        <div className="onboard-pick">
          {(people || []).map((p) => (
            <button key={p.id} className="pill solid big" onClick={() => { tick(); onPick(p.id); }}>{p.name}</button>
          ))}
        </div>
        {!standalone && (
          <div className="install glass">
            <b>Put it on your home screen</b>
            <span>In Safari, tap Share <ShareGlyph />, then <b>Add to Home Screen</b>.</span>
          </div>
        )}
      </div>
    </div>
  );
}

const ShareGlyph = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share" style={{ verticalAlign: '-3px' }}>
    <path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1" />
  </svg>
);
