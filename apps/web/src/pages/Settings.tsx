import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, useData, ago, until, type Bootstrap } from '../api';
import { useApp, agentStateText } from '../App';
import { Dialog, Switch } from '../components/bits';
import { ConnectedApps } from '../components/ConnectedApps';

type SettingsData = Bootstrap & {
  guardrails: { action: string; label: string; description: string; level: string; locked: boolean }[];
  automations: { id: string; label: string; description: string; enabled: boolean; next_run_at: string | null; last_status: string | null }[];
  connections: { id: string; label: string; detail: string; status: string; action: string | null }[];
  memories: { id: string; title: string; body: string; created_at: string }[];
  syncRunning: boolean;
};

export function Settings() {
  const { boot, reload } = useApp();
  const { data, error, reload: refresh } = useData<SettingsData>('/settings', ['sync', 'computer', 'approval']);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const [resetDemo, setResetDemo] = useState(false);
  const run = async (work: () => Promise<unknown>, message = 'Saved.') => {
    setBusy(true); setFailure(''); setNotice('');
    try { await work(); await Promise.all([refresh(), reload()]); setNotice(message); }
    catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveBrand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(() => api('/settings/brand', { method: 'PATCH', body: Object.fromEntries(fields) }));
  };
  const saveDefaults = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(() => api('/settings/defaults', { method: 'PATCH', body: Object.fromEntries(fields) }));
  };
  if (!data) return <div className="empty">{error || 'Loading settings…'}</div>;
  return <div className="page"><div className="page-inner">
    <div className="page-head"><div><h1>Settings</h1><p className="muted">How {boot.agent.name} works, and what it can do.</p></div></div>
    <div aria-live="polite">{notice && <p className="note">{notice}</p>}{(failure || error) && <p role="alert" className="error-text">{failure || error}</p>}</div>
    {boot.demoMode ? <div className="card"><div className="settings-row"><div><strong>Fictional demo workspace</strong><p className="note">Live Penny, invented homes and results. App connections, email delivery and texting are disabled. The demo desktop is read-only. Reset clears demo conversations, approvals, drafts and memories, then restores the sample data.</p></div><button className="btn" disabled={busy} onClick={() => setResetDemo(true)}>Reset demo</button></div></div> : <ConnectedApps />}

    {!boot.demoMode && <><h2 className="section-title">Campaign setup</h2>
    <p className="note">Use your own verified Zoho sender, mailing list and topic. Copy the list and topic IDs exactly from Zoho; they are different from their names. You can save fields as you connect each service.</p>
    <form className="card settings-form" onSubmit={saveDefaults} key={JSON.stringify(data.defaults)}>
      <label>Sender name<input className="field" name="sender_name" defaultValue={data.defaults.sender_name} maxLength={500} /></label>
      <label>Sender email<input className="field" name="sender_email" type="email" defaultValue={data.defaults.sender_email} maxLength={500} /></label>
      <label>Mailing list name<input className="field" name="list_name" defaultValue={data.defaults.list_name} maxLength={500} /></label>
      <label>Mailing list ID<input className="field" name="list_id" defaultValue={data.defaults.list_id} maxLength={500} /></label>
      <label>Topic name<input className="field" name="topic_name" defaultValue={data.defaults.topic_name} maxLength={500} /></label>
      <label>Topic ID<input className="field" name="topic_id" defaultValue={data.defaults.topic_id} maxLength={500} /></label>
      <label>Public AppFolio listings URL<input className="field" name="listings_url" type="url" placeholder="https://your-company.appfolio.com/listings/" defaultValue={data.defaults.listings_url} maxLength={500} /></label>
      <button className="btn primary" disabled={busy}>Save campaign setup</button>
    </form></>}

    <h2 className="section-title">Guardrails</h2>
    <div className="card">{data.guardrails.map(g => <div className="settings-row" key={g.action}>
      <div><strong>{g.label}</strong><p className="note">{g.description}</p></div>
      {g.locked ? <span className="chip">Not available</span> : <select className="field settings-select" aria-label={g.label} value={g.level} disabled={busy} onChange={e => void run(() => api(`/guardrails/${g.action}`, { method: 'PATCH', body: { level: e.target.value } }))}>
        <option value="draft_only">Draft only</option><option value="approve_first">Approve first</option><option value="autonomous">Autonomous</option>
      </select>}
    </div>)}</div>

    <h2 className="section-title">Connections</h2>
    <div className="card">{data.connections.map(c => <div className="settings-row" key={c.id}>
      <div><strong>{c.label}</strong><p className="note">{c.detail}</p></div>
      <div className="settings-actions"><span className={`chip ${c.status === 'connected' ? 'good' : c.status === 'error' ? 'warn' : ''}`}>{c.status.replaceAll('_', ' ')}</span>
        {c.action && <button className="btn sm" disabled={busy} onClick={() => void run(async () => {
          const result = await api<{ url?: string }>(`/connections/${c.id}/${c.action}`, { body: {} });
          if (result.url) window.location.assign(result.url);
        }, c.action === 'connect' ? 'Opening sign-in…' : 'Disconnected.')}>{c.action === 'connect' ? 'Connect' : 'Disconnect'}</button>}
      </div>
    </div>)}<div className="settings-row"><p className="note">Refresh the synced campaigns, results and listings.</p><button className="btn sm" disabled={busy || data.syncRunning} onClick={() => void run(() => api('/sync', { body: {} }), 'Sync started.')}>{data.syncRunning ? 'Syncing…' : 'Sync now'}</button></div></div>

    {!boot.demoMode && <><h2 className="section-title">Automations</h2>
    <div className="card">{data.automations.map(a => <div className="settings-row" key={a.id}>
      <div><strong>{a.label}</strong><p className="note">{a.description}</p><p className="note">{a.enabled ? `Next: ${until(a.next_run_at)}` : 'Paused'}{a.last_status ? ` · Last run: ${a.last_status}` : ''}</p></div>
      <div className="settings-actions"><button className="btn sm" disabled={busy} onClick={() => void run(async () => { const result = await api<{ status?: string }>(`/automations/${a.id}/run`, { body: {} }); if (result.status === 'failed') throw new Error('The automation failed. Check the connection and try again.'); }, 'Automation started.')}>Run now</button><Switch checked={a.enabled} disabled={busy} label={`Enable ${a.label}`} onChange={enabled => void run(() => api(`/automations/${a.id}`, { method: 'PATCH', body: { enabled } }))} /></div>
    </div>)}</div></>}

    <h2 className="section-title">Agent computer</h2>
    <div className="card"><div className="settings-row"><div><strong>{agentStateText(boot)}</strong><p className="note">Last seen {ago(boot.computer.lastSeenAt)}. Messages wait while the agent is off.</p>{boot.computer.error && <p className="error-text">{boot.computer.error}</p>}</div><Switch checked={boot.agent.enabled} disabled={busy} label="Agent enabled" onChange={on => void run(() => api('/computer/power', { body: { on } }))} /></div><div className="settings-row"><p className="note">{boot.demoMode ? 'Review live steps and email previews from any thread. The separate demo desktop is read-only.' : 'Watch the screen or take control from any thread.'}</p><Link className="btn sm" to="/new">Open a thread</Link></div></div>

    <h2 className="section-title">Branding</h2>
    <form className="card settings-form" onSubmit={saveBrand} key={`${data.brand.name}-${data.brand.product}-${data.brand.accent}`}>
      <label>Company name<input className="field" name="name" defaultValue={data.brand.name} maxLength={80} required /></label>
      <label>Product name<input className="field" name="product" defaultValue={data.brand.product} maxLength={80} required /></label>
      <label>Accent colour<input className="field" name="accent" type="color" defaultValue={data.brand.accent} required /></label>
      <button className="btn primary" disabled={busy}>Save branding</button>
    </form>

    <h2 className="section-title">Memory</h2>
    {resetDemo && <Dialog title="Reset the fictional demo?" onClose={() => setResetDemo(false)}><p>This clears only this demo workspace. Wait for Penny to finish before resetting.</p>{failure && <p className="error-text">{failure}</p>}<div className="dialog-actions"><button className="btn" onClick={() => setResetDemo(false)}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void run(async () => { await api('/demo/reset', { body: {} }); window.location.assign('/new'); })}>Reset demo</button></div></Dialog>}
    <div className="card">{data.memories.length ? data.memories.map(m => <div className="settings-row" key={m.id}><div><strong>{m.title}</strong><p className="note" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p></div><button className="btn sm" disabled={busy} onClick={() => setRemove(m.id)}>Forget</button></div>) : <p className="empty">No saved memories yet. Review proposed memories in your approvals.</p>}</div>
    {remove && <Dialog title="Forget this memory?" onClose={() => setRemove(null)}><p>This permanently removes this saved memory. The conversation history stays.</p><div className="dialog-actions"><button className="btn" onClick={() => setRemove(null)}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void run(async () => { await api(`/memories/${remove}`, { method: 'DELETE' }); setRemove(null); }, 'Memory removed.')}>Forget memory</button></div></Dialog>}
  </div></div>;
}
