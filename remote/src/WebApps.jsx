import { useEffect, useState } from 'react';
import * as Ic from './icons.jsx';
import { tick } from './haptics.js';
import { api } from './api.js';

const COLOURS = ['#6d3df2', '#e5484d', '#f5a623', '#2da44e', '#0a84ff', '#8e8e93'];

/**
 * Web apps: websites that open full screen on the TV (popups and ads blocked there).
 * Lives in the TV sheet. The list is kept on the bridge, so the TV and a backup both have it.
 */
export function WebAppsBlock({ open }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [hosts, setHosts] = useState('');
  const [colour, setColour] = useState(COLOURS[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState('');

  useEffect(() => {
    if (!open) return;
    api.webapps().then((j) => setList(j.webapps || []), () => setList([]));
  }, [open]);

  const run = (body, done) => {
    setBusy(true); setNote('');
    api.webappsSet(body).then((j) => { setList(j.webapps || []); done?.(); }, (e) => setNote(e.message || 'That did not work.'))
      .then(() => setBusy(false));
  };

  const add = (e) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    tick();
    run({ action: 'add', name: name.trim(), url: url.trim(), allowed_hosts: hosts, colour }, () => {
      setName(''); setUrl(''); setHosts(''); setAdding(false); setNote('Added. It shows up on the TV in a moment.');
    });
  };

  return (
    <section className="more-block group">
      <h3><Ic.Screen size={16} /> Web apps</h3>
      {list && list.length === 0 && <p className="note">No web apps yet.</p>}
      {(list || []).map((w) => (
        <div key={w.id} className="list-row" style={{ cursor: 'default' }}>
          <span className="row-icon" style={{ background: w.colour, color: '#fff', fontWeight: 700 }}>{w.letter}</span>
          <span className="row-text"><b>{w.name}</b><small>{w.url.replace(/^https?:\/\//, '')}</small></span>
          <button className="chip glass" disabled={busy}
            onClick={() => { tick(); if (sure !== w.id) { setSure(w.id); return; } setSure(''); run({ action: 'remove', id: w.id }); }}>
            {sure === w.id ? 'Sure?' : 'Remove'}
          </button>
        </div>
      ))}
      {adding ? (
        <form onSubmit={add} className="webapp-form">
          <div className="ask-field glass"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, like Vidbox" aria-label="Web app name" maxLength={40} /></div>
          <div className="ask-field glass"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Address, like https://example.com" aria-label="Web app address" inputMode="url" autoCapitalize="none" autoCorrect="off" /></div>
          <div className="ask-field glass"><input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="Other sites it may open (optional)" aria-label="Allowed sites" autoCapitalize="none" autoCorrect="off" /></div>
          <div className="chips-row" role="radiogroup" aria-label="Colour">
            {COLOURS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={colour === c} className={`chip glass ${colour === c ? 'on' : ''}`}
                style={{ minWidth: 44, background: c, borderColor: colour === c ? '#fff' : 'transparent' }} onClick={() => { tick(); setColour(c); }} aria-label={c} />
            ))}
          </div>
          <div className="chips-row">
            <button type="submit" className="chip glass on" disabled={busy || !name.trim() || !url.trim()}>Add to the TV</button>
            <button type="button" className="chip glass" onClick={() => { tick(); setAdding(false); setNote(''); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="chips-row"><button className="chip glass" onClick={() => { tick(); setAdding(true); setNote(''); }}>Add a web app</button></div>
      )}
      <p className="note">{note || 'These open full screen on the TV with a pointer. Popups, ads and adult sites are blocked, but no list catches everything.'}</p>
    </section>
  );
}
