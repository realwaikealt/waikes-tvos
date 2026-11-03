import { useEffect, useState } from 'react';
import * as Ic from './icons.jsx';
import { tick } from './haptics.js';
import { request } from './net.js';

// Messages: the "work finished" notes Claude leaves for the TV (and here). Lives in the TV sheet.
const get = async (path) => JSON.parse((await request('GET', path, undefined, 8000)).text);
const post = async (path, body) => JSON.parse((await request('POST', path, JSON.stringify(body), 8000)).text);

const niceTime = (m) => {
  const d = new Date(m.time || (m.ts || 0) * 1000);
  return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function MessagesBlock({ open }) {
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState('');
  const load = () => get('/api/inbox').then((j) => setList(j.messages || []), () => setList([]));
  useEffect(() => { if (open) load(); }, [open]);
  const unread = (list || []).filter((m) => !m.read).length;
  const readAll = () => { tick(); post('/api/inbox/ack', { id: 'all' }).then(load, load); };
  return (
    <section className="more-block group messages-block">
      <h3><Ic.Info size={16} /> Messages{unread ? ` (${unread} new)` : ''}</h3>
      {list && !list.length && <p className="more-note">Nothing yet. When Claude finishes work, a note shows here and pops up on the TV.</p>}
      {(list || []).slice(0, 12).map((m) => (
        <div key={m.id} className="msg-item">
          <button className="list-row" onClick={() => { tick(); setOpenId(openId === m.id ? '' : m.id); }}>
            <span className="row-text"><b>{!m.read && <span className="msg-dot" aria-label="unread" />}{m.title}</b><small>{niceTime(m)}</small></span>
            <Ic.Chevron className="row-chev" />
          </button>
          {openId === m.id && (
            <div className="msg-detail">
              <p>{m.summary}</p>
              {m.items?.length > 0 && <ul>{m.items.map((i, k) => <li key={k}>{i}</li>)}</ul>}
            </div>
          )}
        </div>
      ))}
      {unread > 0 && <button className="pill glass arrange-open" onClick={readAll}>Mark all as read</button>}
    </section>
  );
}
