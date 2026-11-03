import { useEffect, useState } from 'react';
import { netState, onNetChange, connectionTest, isStandalone } from './net.js';

// What really went wrong, a connection test, and (in a Home Screen app) the iOS Local Network steps.
export function ConnectionHelp({ compact }) {
  const [last, setLast] = useState(netState.last);
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => onNetChange(setLast), []);
  const run = async () => { setBusy(true); setCopied(false); try { await connectionTest(setReport); } finally { setBusy(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(report); setCopied(true); } catch { /* ignore */ } };
  const st = isStandalone();
  const detail = last ? `${last.name || 'Error'}: ${last.message || ''} · ${last.url || ''}${last.status != null ? ` · HTTP ${last.status}` : ''} · via ${last.via || '?'} · ${last.at}` : null;
  return (
    <div className="conn-help">
      {detail && <p className="conn-detail">Details: {detail}</p>}
      {st && !compact && (
        <div className="conn-ios">
          <p><b>On iPhone, a Home Screen app needs permission to reach devices on your Wi-Fi.</b></p>
          <ol>
            <li>Open <b>Settings</b> › <b>Privacy &amp; Security</b> › <b>Local Network</b>.</li>
            <li>Turn on the switch for <b>Asher’s tvOS</b> (or <b>Safari</b>).</li>
            <li>Come back here and tap <b>Try again</b>.</li>
          </ol>
          <p>No switch listed? Delete the icon, open this address in Safari, tap Share › Add to Home Screen, and turn <b>Open as Web App</b> off.</p>
          <p><a className="pill glass conn-link" href="/diag">Open diagnostics</a></p>
        </div>
      )}
      <button className="pill glass conn-test" disabled={busy} onClick={run}>{busy ? 'Testing…' : 'Run connection test'}</button>
      {report && <><pre className="conn-report">{report}</pre><button className="pill glass conn-test" onClick={copy}>{copied ? 'Copied' : 'Copy results'}</button></>}
    </div>
  );
}
