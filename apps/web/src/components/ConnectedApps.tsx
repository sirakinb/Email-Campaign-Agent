import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Dialog } from './bits';

type App = { slug: string; name: string; logo?: string; status: string; detail: string };
type CatalogApp = { slug: string; name: string; logo?: string; description?: string };

export function ConnectedApps() {
  const [apps, setApps] = useState<App[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState<App | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogApp[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const generation = useRef(0);
  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const data = await api<{ configured: boolean; apps: App[] }>('/connected-apps?refresh=true');
      setApps(data.apps); setConfigured(data.configured);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const id = ++generation.current;
    if (!open) return;
    setSearching(true); setCatalogError(''); setResults([]); setCursor(null);
    const timer = setTimeout(() => {
      api<{ apps: CatalogApp[]; nextCursor: string | null }>(`/connected-apps/catalog?q=${encodeURIComponent(query)}`)
        .then((data) => { if (generation.current === id) { setResults(data.apps); setCursor(data.nextCursor); } })
        .catch((e) => { if (generation.current === id) setCatalogError(e.message); })
        .finally(() => { if (generation.current === id) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); generation.current++; };
  }, [query, open]);
  const more = async () => {
    if (!cursor) return;
    const id = generation.current;
    setSearching(true); setCatalogError('');
    try {
      const data = await api<{ apps: CatalogApp[]; nextCursor: string | null }>(`/connected-apps/catalog?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`);
      if (generation.current === id) { setResults((previous) => [...previous, ...data.apps.filter((app) => !previous.some((p) => p.slug === app.slug))]); setCursor(data.nextCursor); }
    } catch (e) { if (generation.current === id) setCatalogError((e as Error).message); }
    finally { if (generation.current === id) setSearching(false); }
  };
  const connect = async (slug: string) => {
    setBusy(slug); setError(''); setCatalogError('');
    try {
      const { url } = await api<{ url: string }>(`/connected-apps/${encodeURIComponent(slug)}/connect`, { body: {} });
      window.location.assign(url);
    } catch (e) { setError((e as Error).message); setCatalogError((e as Error).message); setBusy(''); }
  };
  return <section aria-label="Connected apps">
    <div className="apps-heading"><div><h2 className="section-title">Apps</h2><p className="note">Connect your accounts through Composio so Penny can work with them.</p></div><button className="btn sm" disabled={!configured || Boolean(busy)} onClick={() => { setQuery(''); setOpen(true); }}>Add app</button></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="card">
      {apps.map((app) => <div className="settings-row" key={app.slug}>
        <div><strong>{app.name}</strong><p className="note">{app.detail}</p></div>
        <div className="settings-actions"><span className={`chip ${app.status === 'connected' ? 'good' : app.status === 'error' ? 'warn' : ''}`}>{app.status.replaceAll('_', ' ')}</span>
          {app.status !== 'connected' && <button className="btn sm" disabled={Boolean(busy)} onClick={() => void connect(app.slug)}>{busy === app.slug ? 'Opening…' : 'Connect'}</button>}
          {app.status === 'connected' && <button className="btn sm" disabled={Boolean(busy)} onClick={() => void connect(app.slug)}>Reconnect</button>}
          <button className="btn sm" disabled={Boolean(busy)} onClick={() => setRemove(app)}>Disconnect</button>
        </div>
      </div>)}
      {!apps.length && <p className="empty">{loading ? 'Checking your apps…' : !configured ? 'Composio needs its project key before accounts can be connected.' : 'Connect Gmail, Google Drive, Calendar, or another app to get started.'}</p>}
      <div className="settings-row"><p className="note">Gmail search and reading are available directly. Other actions follow the “Connected app actions” guardrail.</p><button className="btn sm" disabled={loading} onClick={() => void refresh()}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    </div>
    {open && <Dialog title="Add an app" onClose={() => !busy && setOpen(false)}>
      <p className="note">Choose an app and authorize your account. You’ll return here when it’s connected.</p>
      <input className="field app-search" type="search" autoFocus aria-label="Search apps" placeholder="Search apps, e.g. Gmail" value={query} onChange={(e) => setQuery(e.target.value)} />
      {catalogError && <p className="error-text" role="alert">{catalogError}</p>}
      <div className="app-catalog" aria-live="polite" aria-busy={searching}>
        {results.map((app) => {
          const connected = apps.some((a) => a.slug === app.slug && a.status === 'connected');
          return <div className="app-catalog-row" key={app.slug}><div><strong>{app.name}</strong><p className="note">{app.description}</p></div><button className="btn sm" disabled={Boolean(busy) || connected} onClick={() => void connect(app.slug)}>{connected ? 'Connected' : busy === app.slug ? 'Opening…' : 'Connect'}</button></div>;
        })}
        {searching && <p className="note">Loading apps…</p>}
        {!searching && !results.length && !catalogError && <p className="note">No apps found. Try a different name. Zoho and Cloudinary are managed in Connections below.</p>}
      </div>
      <div className="dialog-actions">{cursor && <button className="btn" disabled={searching} onClick={() => void more()}>Load more</button>}<button className="btn" disabled={Boolean(busy)} onClick={() => setOpen(false)}>Close</button></div>
    </Dialog>}
    {remove && <Dialog title={`Disconnect ${remove.name}?`} onClose={() => !busy && setRemove(null)}>
      <p>Penny will lose access immediately, including for pending actions. Your account stays in Composio and can be reconnected later.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="btn" disabled={Boolean(busy)} onClick={() => setRemove(null)}>Cancel</button><button className="btn danger" disabled={Boolean(busy)} onClick={async () => {
        setBusy(remove.slug); setError('');
        try { await api(`/connected-apps/${encodeURIComponent(remove.slug)}/disconnect`, { body: {} }); setRemove(null); await refresh(); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(''); }
      }}>Disconnect</button></div>
    </Dialog>}
  </section>;
}
