import { useCallback, useEffect, useState } from 'react';
import { tick } from './haptics.js';

// Feature switches (bridge/features.py). One list, on the TV (Settings > Features) and here. A block that is off is hidden.
async function getFeatures() {
  const r = await fetch('/api/features', { cache: 'no-store' });
  if (!r.ok) throw new Error('status ' + r.status);
  return (await r.json()).features || [];
}

// {id: boolean}; empty until loaded, so nothing is hidden before the answer arrives (and nothing breaks with the bridge off).
export function useFeatures(open) {
  const [list, setList] = useState(null);
  const refresh = useCallback(() => { getFeatures().then(setList, () => {}); }, []);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  const on = {};
  (list || []).forEach((f) => { on[f.id] = f.on; });
  return { list, on, refresh, setList };
}

export function FeaturesBlock({ features }) {
  const { list, setList } = features;
  const [err, setErr] = useState('');
  if (!list) return null;
  const flip = async (f) => {
    tick();
    setErr('');
    setList(list.map((x) => (x.id === f.id ? { ...x, on: !f.on } : x)));
    try {
      const r = await fetch('/api/features', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: f.id, on: !f.on }) });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || 'status ' + r.status);
      setList(j.features);
    } catch (e) {
      setList(list);
      setErr('Couldn’t save that. Is your phone on the home Wi-Fi?');
    }
  };
  return (
    <section className="more-block group feat-block">
      <h3>Features</h3>
      <p className="more-note">Turn parts of Asher’s tvOS on or off. Nothing is deleted.</p>
      {list.map((f) => (
        <button key={f.id} className="feat-row" role="switch" aria-checked={f.on} onClick={() => flip(f)}>
          <span className="feat-text"><b>{f.label}</b><small>{f.note}</small></span>
          <span className={`feat-sw ${f.on ? 'on' : ''}`} aria-hidden="true"><i /></span>
        </button>
      ))}
      {err && <p className="more-note">{err}</p>}
    </section>
  );
}
