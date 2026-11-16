import { useEffect, useState } from 'react';
import { ExternalLink, Hand, MonitorPlay, Send, Upload, X } from 'lucide-react';
import { api, clock, shortDate, liveSendLabel, type Draft, type Step } from '../api';
import { Mascot, Switch } from './bits';
import { useApp } from '../App';
import { ResizeHandle } from './ResizeHandle';

type Tab = 'preview' | 'screen' | 'steps';

/**
 * The agent's computer: what it is making (the email preview), its screen,
 * and the steps it has taken. On narrow screens it opens full height.
 */
export function ComputerPanel(props: {
  open: boolean;
  onClose: () => void;
  drafts: Draft[];
  steps: Step[];
  selectedDraft: string | null;
  onSelectDraft: (id: string) => void;
  working: boolean;
  onAsk: (message: string) => void;
}) {
  const { boot, reload } = useApp();
  const [tab, setTab] = useState<Tab>(boot.demoMode && !props.drafts.length ? 'screen' : 'preview');
  const [screen, setScreen] = useState<{ url: string; control: boolean } | null>(null);
  const [screenError, setScreenError] = useState('');
  const [busy, setBusy] = useState(false);

  const draft = props.drafts.find((d) => d.id === props.selectedDraft) ?? props.drafts[props.drafts.length - 1] ?? null;

  // A new draft is the thing to look at.
  useEffect(() => {
    if (props.drafts.length) setTab('preview');
  }, [props.drafts.length]);
  useEffect(() => {
    if (props.selectedDraft) setTab('preview');
  }, [props.selectedDraft]);

  const power = async (on: boolean) => {
    setBusy(true);
    try {
      await api('/computer/power', { body: { on } });
    } catch {
      /* status text shows the outcome */
    }
    if (!on) setScreen(null);
    setBusy(false);
    reload();
  };

  const watch = async (control: boolean) => {
    setBusy(true);
    setScreenError('');
    try {
      const link = await api<{ url: string }>('/computer/screen', { body: { control } });
      setScreen({ url: link.url, control });
    } catch (e) {
      setScreenError((e as Error).message);
    }
    setBusy(false);
  };

  const handBack = async () => {
    setBusy(true);
    setScreenError('');
    try {
      await api('/computer/handback', { body: {} });
      // Close the interactive connection before creating a read-only viewer.
      setScreen(null);
      await watch(false);
    } catch (e) {
      setScreenError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const state = !boot.agent.enabled
    ? 'Switched off'
    : props.working && boot.computer.agentOnline
      ? 'Working'
      : boot.computer.agentOnline
        ? 'On, waiting for work'
        : boot.computer.state === 'asleep'
          ? 'Asleep, wakes on a message'
          : boot.computer.configured
            ? 'Offline'
            : 'Not connected yet';

  return (
    <aside className={`computer${props.open ? ' open' : ''}`} aria-label={`${boot.agent.name}'s computer`}>
      <ResizeHandle side="left" storageKey="computer-width" initial={440} min={300} max={1100} label="Resize computer panel" />
      <div className="computer-card">
        <div className="computer-head">
          <Mascot size={26} asleep={!boot.agent.enabled || !boot.computer.agentOnline} working={props.working} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{boot.agent.name}’s computer</div>
            <div className="state">{busy ? 'One moment' : state}</div>
          </div>
          <Switch checked={boot.agent.enabled} disabled={busy} onChange={power} label={`Turn ${boot.agent.name} ${boot.agent.enabled ? 'off' : 'on'}`} />
          <button className="icon-btn" aria-label="Close computer panel" onClick={props.onClose}>
            <X />
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(['preview', 'screen', 'steps'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
              {t === 'preview' ? 'Email preview' : t === 'screen' ? 'Screen' : `Steps${props.steps.length ? ` (${props.steps.length})` : ''}`}
            </button>
          ))}
        </div>

        <div className="computer-body">
          {tab === 'preview' &&
            (draft ? (
              <>
                {props.drafts.length > 1 && (
                  <div className="draft-tabs" role="tablist">
                    {props.drafts.map((d, i) => (
                      <button key={d.id} role="tab" aria-selected={d.id === draft.id} className="draft-tab" onClick={() => props.onSelectDraft(d.id)} title={d.name}>
                        {d.send_on ? shortDate(d.send_on) : `Draft ${i + 1}`}
                      </button>
                    ))}
                  </div>
                )}
                <div className="preview-meta">
                  <div className="subject">{draft.subject}</div>
                  {draft.subject_b && <div className="note">Alternative: {draft.subject_b}</div>}
                  {draft.preheader && <div className="note">Preview text: {draft.preheader}</div>}
                  <div className="note">
                    From {boot.defaults.sender_name} · To the {boot.defaults.list_name} list
                    {draft.send_on ? ` · Planned for ${shortDate(draft.send_on)}` : ''}
                  </div>
                </div>
                <iframe
                  className="preview-frame"
                  title={`Preview of ${draft.subject}`}
                  sandbox=""
                  src={`/api/drafts/${draft.id}/preview?v=${encodeURIComponent(draft.updated_at)}`}
                />
                <div className="preview-actions">
                  <span className={`chip ${draft.status === 'uploaded' ? 'good' : draft.status === 'tested' ? 'accent' : ''}`}>
                    {liveSendLabel(draft.status) || (draft.status === 'uploaded' ? (boot.demoMode ? 'Simulated Zoho draft' : 'In Zoho as a draft') : draft.status === 'tested' ? (boot.demoMode ? 'Test simulated' : 'Test sent to you') : 'Draft, not uploaded')}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" disabled={props.working} onClick={() => props.onAsk(`Send me a test of the draft "${draft.subject}".`)}>
                    <Send /> {boot.demoMode ? 'Simulate test' : 'Send me a test'}
                  </button>
                  <button className="btn sm" disabled={props.working || Boolean(liveSendLabel(draft.status))} onClick={() => props.onAsk(`Upload the draft "${draft.subject}" to Zoho Campaigns as a draft.`)}>
                    <Upload /> {boot.demoMode ? 'Simulate Zoho upload' : draft.zoho_campaign_id ? 'Update in Zoho' : 'Upload to Zoho'}
                  </button>
                </div>
              </>
            ) : (
              <div className="screen-empty">
                <div>
                  <p style={{ color: 'var(--ink)' }}>No draft in this thread yet</p>
                  <p className="note" style={{ marginTop: 4 }}>
                    When {boot.agent.name} writes an email, it shows here exactly as it will be sent.
                  </p>
                </div>
              </div>
            ))}

          {tab === 'screen' && (
            <div className="screen">
              {screen ? (
                <>
                  {/* Permissions are encoded in the URL fragment. Changing only the
                      fragment doesn't reload the viewer, so remount for each token. */}
                  <iframe key={screen.url} title={`${boot.agent.name}'s screen`} src={screen.url} allow="clipboard-read; clipboard-write; fullscreen" tabIndex={0} onLoad={e => { if (screen.control) e.currentTarget.focus(); }} />
                  <div className="preview-actions">
                    <span className={`chip ${screen.control ? 'warn' : ''}`}>{boot.demoMode ? 'Demo computer · Read-only' : screen.control ? 'You are in control' : 'Watching'}</span>
                    <span style={{ flex: 1 }} />
                    {screen.control ? (
                      <button className="btn sm" disabled={busy} onClick={handBack}>
                        Hand back
                      </button>
                    ) : !boot.demoMode ? (
                      <button className="btn sm" disabled={busy} onClick={() => watch(true)}>
                        <Hand /> Take control
                      </button>
                    ) : null}
                    <a className="btn sm ghost" href={screen.url} target="_blank" rel="noreferrer noopener">
                      <ExternalLink /> Open
                    </a>
                  </div>
                </>
              ) : (
                <div className="screen-empty">
                  <div>
                    {boot.computer.configured ? (
                      <>
                        <p style={{ color: 'var(--ink)' }}>Watch {boot.agent.name}’s screen</p>
                        <p className="note" style={{ margin: '4px 0 14px' }}>
                          {boot.demoMode ? 'View the separate demo machine with fictional properties. Penny’s tool calls appear in Steps; they do not move the mouse on this desktop.' : 'See the desktop live. You can take control at any time, and hand it back when you are done.'}
                        </p>
                        <button className="btn" disabled={busy || !boot.agent.enabled} onClick={() => watch(false)}>
                          <MonitorPlay /> {busy ? 'Connecting' : 'Watch'}
                        </button>
                        {screenError && (
                          <p className="error-text" style={{ marginTop: 10 }}>
                            {screenError}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p style={{ color: 'var(--ink)' }}>No computer connected yet</p>
                        <p className="note" style={{ marginTop: 4 }}>
                          Once {boot.agent.name} is set up on its InstaBox machine, its screen shows here.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}
              {screen && screenError && <p role="alert" className="error-text" style={{ padding: '8px 14px' }}>{screenError}</p>}
            </div>
          )}

          {tab === 'steps' &&
            (props.steps.length ? (
              <div className="step-list">
                {props.steps.map((s) => (
                  <div className="step-item" key={s.id}>
                    <time>{clock(s.created_at).replace(' ', ' ')}</time>
                    <div>
                      <div className="label">{s.label}</div>
                      {s.detail && <div className="detail">{s.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="screen-empty">
                <p>Each thing {boot.agent.name} does in this thread is listed here.</p>
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
}
