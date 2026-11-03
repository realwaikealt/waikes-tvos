import { useEffect, useMemo, useRef, useState } from 'react';
import * as Ic from './icons.jsx';
import { tick } from './haptics.js';
import { api } from './api.js';

/**
 * Wallpaper Engine wallpapers from the computer as the TV's home background.
 * Videos play on the TV; the other kinds show as a still picture (live scenes would need the computer to stream them).
 * Lives in the TV sheet; the choice is kept on the bridge and mirrored on the TV.
 */
export function WallpaperBlock({ open }) {
  const [data, setData] = useState(null);      // {engine, ffmpeg, items, current}
  const [cur, setCur] = useState(null);        // {id, state, kind, detail}
  const [filter, setFilter] = useState('video');
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const poll = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let dead = false;
    api.wallpapers().then((j) => { if (!dead) { setData(j); setCur(j.current ? { id: j.current.id } : null); } },
      () => { if (!dead) setData({ items: [], engine: false, error: true }); });
    api.wallpaperNow().then((s) => { if (!dead) setCur(s); }, () => {});
    return () => { dead = true; clearTimeout(poll.current); };
  }, [open]);

  const watch = () => {
    clearTimeout(poll.current);
    poll.current = setTimeout(() => api.wallpaperNow().then((s) => {
      setCur(s);
      if (s.state === 'preparing') { setNote('Getting it ready for the TV. This takes a minute or two.'); watch(); }
      else setNote(s.state === 'error' ? (s.detail || 'That video is not available.') : 'On the TV now.');
    }, () => {}), 3000);
  };

  const pick = (id) => {
    tick(); setBusy(id); setNote('');
    api.wallpaperSet(id).then((s) => {
      setCur(s);
      if (s.state === 'preparing') { setNote('Getting it ready for the TV. This takes a minute or two.'); watch(); }
      else if (s.state === 'error') setNote(s.detail || 'That video is not available.');
      else setNote(id === 'scenes' ? 'Back to the built-in scenes.' : 'On the TV now.');
    }, (e) => setNote(e.message || 'That did not work.')).then(() => setBusy(''));
  };

  const items = useMemo(() => {
    const list = (data?.items || []).filter((x) => (filter === 'video' ? x.video : filter === 'picture' ? !x.video : true));
    const s = q.trim().toLowerCase();
    return s ? list.filter((x) => x.title.toLowerCase().includes(s)) : list;
  }, [data, filter, q]);

  const current = cur?.id || 'scenes';
  const currentTitle = current === 'scenes' ? 'Built-in scenes' : (data?.items || []).find((x) => x.id === current)?.title || 'Wallpaper Engine';

  if (data && !data.engine && !data.error) {
    return (
      <section className="more-block group">
        <h3><Ic.Screen size={16} /> Wallpaper</h3>
        <p className="note">Wallpaper Engine was not found on the computer. Install it from Steam to use its wallpapers here.</p>
      </section>
    );
  }
  return (
    <section className="more-block group wp-block">
      <h3><Ic.Screen size={16} /> Wallpaper</h3>
      <p className="note" style={{ marginTop: 0 }}>Now: <b>{currentTitle}</b></p>
      <div className="chips-row" role="radiogroup" aria-label="Kind">
        {[['video', 'Videos'], ['picture', 'Pictures']].map(([k, label]) => (
          <button key={k} role="radio" aria-checked={filter === k} className={`chip glass ${filter === k ? 'on' : ''}`} onClick={() => { tick(); setFilter(k); }}>{label}</button>
        ))}
        <button className={`chip glass ${current === 'scenes' ? 'on' : ''}`} disabled={busy === 'scenes'} onClick={() => pick('scenes')}>Built-in</button>
      </div>
      <div className="ask-field glass" style={{ marginTop: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search wallpapers" aria-label="Search wallpapers" autoCapitalize="none" autoCorrect="off" />
      </div>
      {!data && <p className="note">Looking on the computer…</p>}
      {data?.error && <p className="note">The computer did not answer.</p>}
      <div className="wp-strip" role="list">
        {items.slice(0, 120).map((x) => (
          <button key={x.id} role="listitem" className={`wp-tile ${current === x.id ? 'on' : ''}`} disabled={!!busy} onClick={() => pick(x.id)} aria-label={x.title}>
            <img src={x.preview} alt="" loading="lazy" decoding="async" />
            <span>{x.title}</span>
          </button>
        ))}
      </div>
      {items.length > 120 && <p className="note">Showing the first 120. Use search to find the rest.</p>}
      {data && data.ffmpeg === false && <p className="note">Videos need ffmpeg on the computer to be made TV-friendly.</p>}
      <p className="note">{note || 'Videos play on the TV, muted. Other kinds show as a still picture.'}</p>
    </section>
  );
}
