import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, Inbox, Layers, Menu, Plus, Settings as SettingsIcon } from 'lucide-react';
import { api, useData, ago, type Bootstrap, type ThreadSummary } from './api';
import { ChannelIcon, Mascot, Switch } from './components/bits';
import { Today } from './pages/Today';
import { Thread } from './pages/Thread';
import { Campaigns } from './pages/Campaigns';
import { CampaignDetail } from './pages/CampaignDetail';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';
import { ResizeHandle } from './components/ResizeHandle';

type AppState = { boot: Bootstrap; reload: () => void };
const AppContext = createContext<AppState | null>(null);
export const useApp = () => useContext(AppContext)!;

export function agentStateText(boot: Bootstrap): string {
  const name = boot.agent.name;
  if (!boot.agent.enabled) return `${name} is switched off`;
  if (boot.computer.agentOnline) return `${name} is on`;
  if (boot.computer.state === 'asleep') return `${name} is asleep, wakes on a message`;
  if (boot.computer.state === 'starting') return `${name} is starting`;
  if (!boot.computer.configured) return `${name} is not connected yet`;
  return `${name} is offline`;
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { boot, reload } = useApp();
  const threads = useData<{ threads: ThreadSummary[] }>('/threads', ['threads']);
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const list = threads.data?.threads ?? [];
  const open_ = list.filter((t) => t.status === 'open');
  const settled = list.filter((t) => t.status === 'settled');

  useEffect(onClose, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api('/computer/power', { body: { on } });
    } catch {
      /* the status line shows the result */
    }
    setBusy(false);
    reload();
  };

  const row = (t: ThreadSummary) => (
    <NavLink key={t.id} to={`/t/${t.id}`} className={({ isActive }) => `thread-row${isActive ? ' active' : ''}${t.status === 'settled' ? ' settled' : ''}`}>
      <span className={`dot${t.working ? ' working' : t.pending_approvals ? ' waiting' : ''}`} />
      <span className="thread-body">
        <div className="thread-title">{t.title}</div>
        <div className="thread-meta">
          {t.status === 'settled'
            ? 'Settled'
            : t.working
              ? 'Working'
              : t.pending_approvals
                ? `Waiting on you${t.pending_approvals > 1 ? ` (${t.pending_approvals})` : ''}`
                : ago(t.last_message_at)}
          {t.series ? ` · ${t.series}` : ''}
        </div>
      </span>
      {t.last_channel && t.last_channel !== 'chat' && (
        <span className="muted" style={{ display: 'inline-flex', marginTop: 3 }} title={`Last message by ${t.last_channel}`}>
          <span style={{ width: 13, height: 13, display: 'inline-flex' }}>
            <ChannelIcon channel={t.last_channel} />
          </span>
        </span>
      )}
    </NavLink>
  );

  return (
    <>
      {open && <div className="side-scrim show-narrow" onClick={onClose} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <ResizeHandle side="right" storageKey="sidebar-width" initial={272} min={200} max={420} label="Resize sidebar" />
        <Link to="/" className="brand">
          <Mascot size={28} asleep={!boot.agent.enabled} />
          <span>
            <div className="brand-name">{boot.brand.name}</div>
            <div className="brand-sub">{boot.brand.product}</div>
          </span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Inbox /> Today
            {boot.pendingApprovals > 0 && <span className="count">{boot.pendingApprovals}</span>}
          </NavLink>
          <NavLink to="/campaigns" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Layers /> Campaigns
          </NavLink>
          <NavLink to="/analytics" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <BarChart3 /> Analytics
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <SettingsIcon /> Settings
          </NavLink>
        </nav>
        <div className="side-label">
          <span>Threads</span>
          <button className="icon-btn" aria-label="New thread" title="New thread" onClick={() => navigate('/new')} style={{ width: 22, height: 22 }}>
            <Plus />
          </button>
        </div>
        <div className="threads">
          {open_.map(row)}
          {!list.length && <div className="empty note">{boot.demoMode ? 'Start a thread to explore the fictional homes with Penny.' : `No threads yet. Start one, or text or email ${boot.agent.name}.`}</div>}
          {settled.length > 0 && (
            <>
              <div className="side-label" style={{ padding: '14px 10px 6px' }}>
                <span>Settled</span>
              </div>
              {settled.map(row)}
            </>
          )}
        </div>
        <div className="side-foot">
          <Mascot size={22} asleep={!boot.agent.enabled || (!boot.computer.agentOnline && boot.computer.state !== 'starting')} working={boot.computer.agentOnline} />
          <div className="who">
            <div className="who-name">{boot.agent.name}</div>
            <div className="who-state">{busy ? 'One moment' : agentStateText(boot).replace(`${boot.agent.name} is `, '').replace(/^./, (c) => c.toUpperCase())}</div>
          </div>
          <Switch checked={boot.agent.enabled} disabled={busy} onChange={toggle} label={`Turn ${boot.agent.name} ${boot.agent.enabled ? 'off' : 'on'}`} />
        </div>
      </aside>
    </>
  );
}

function Shell() {
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  const { boot } = useApp();
  const titles: Record<string, string> = { '/': 'Today', '/campaigns': 'Campaigns', '/analytics': 'Analytics', '/settings': 'Settings', '/new': 'New thread' };
  const title = titles[location.pathname] ?? (location.pathname.startsWith('/campaigns/') ? 'Campaign' : boot.agent.name);
  return (
    <div className={`shell${boot.demoMode ? ' demo-shell' : ''}`}>
      {boot.demoMode && <div className="demo-banner">Live demo · Fictional data · External actions are simulated</div>}
      <div className="mobile-bar">
        <button className="icon-btn" aria-label="Open menu" onClick={() => setMenu(true)} style={{ width: 36, height: 36 }}>
          <Menu />
        </button>
        <span className="title" id="mobile-title">
          {title}
        </span>
        <span id="mobile-actions" style={{ display: 'flex', gap: 2 }} />
      </div>
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <main className="content">
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/new" element={<Thread key="new" />} />
          <Route path="/t/:id" element={<Thread />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Today />} />
        </Routes>
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { body: { password } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <Mascot size={44} />
        <h1>Command center</h1>
        <p className="muted" style={{ marginBottom: 18 }}>
          Enter your password to continue.
        </p>
        <input className="field" type="password" autoFocus autoComplete="current-password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p className="error-text" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
        <button className="btn primary" style={{ width: '100%', height: 38, marginTop: 12 }} disabled={busy || !password}>
          Sign in
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ signedIn: boolean }>('/session').then((s) => setSignedIn(s.signedIn)).catch(() => setSignedIn(false));
    const out = () => setSignedIn(false);
    window.addEventListener('signed-out', out);
    return () => window.removeEventListener('signed-out', out);
  }, []);
  if (signedIn === null) return null;
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;
  return <SignedIn />;
}

function SignedIn() {
  const boot = useData<Bootstrap>('/bootstrap', ['computer', 'approval']);
  useEffect(() => {
    // The brand colour is a setting, so a client can re-skin without a rebuild.
    if (boot.data?.brand.accent) document.documentElement.style.setProperty('--accent', boot.data.brand.accent);
    if (boot.data) document.title = `${boot.data.brand.product} · ${boot.data.brand.name}`;
  }, [boot.data]);
  // Machine state is not pushed, so check it now and then.
  useEffect(() => {
    const timer = setInterval(boot.reload, 30_000);
    return () => clearInterval(timer);
  }, [boot.reload]);
  if (!boot.data) return boot.error ? <div className="empty">{boot.error}</div> : null;
  return (
    <AppContext.Provider value={{ boot: boot.data, reload: boot.reload }}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AppContext.Provider>
  );
}
