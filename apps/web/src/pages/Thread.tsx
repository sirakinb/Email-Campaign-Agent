import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowUp, Check, CheckCheck, FileText, Monitor, MoreHorizontal, RotateCcw, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { api, clock, onLive, shortDate, useData, liveSendLabel, type Approval, type Draft, type Message, type Step, type ThreadDetail } from '../api';
import { ChannelTag, Dialog, Markdown, Mascot } from '../components/bits';
import { ComputerPanel } from '../components/ComputerPanel';
import { useApp, agentStateText } from '../App';

type Item =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'steps'; at: string; steps: Step[] }
  | { kind: 'approval'; at: string; approval: Approval }
  | { kind: 'draft'; at: string; draft: Draft };

function timeline(detail: ThreadDetail): Item[] {
  const items: Item[] = [
    ...detail.messages.map((message) => ({ kind: 'message' as const, at: message.created_at, message })),
    ...detail.approvals.map((approval) => ({ kind: 'approval' as const, at: approval.created_at, approval })),
    ...detail.drafts.map((draft) => ({ kind: 'draft' as const, at: (draft as Draft & { created_at: string }).created_at, draft })),
  ];
  const withSteps: (Item | { kind: 'step'; at: string; step: Step })[] = [
    ...items,
    ...detail.steps.map((step) => ({ kind: 'step' as const, at: step.created_at, step })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // Consecutive steps read as one quiet block.
  const out: Item[] = [];
  for (const item of withSteps) {
    if (item.kind === 'step') {
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.steps.push(item.step);
      else out.push({ kind: 'steps', at: item.at, steps: [item.step] });
    } else out.push(item);
  }
  return out;
}

const SUGGESTIONS = [
  'How did the last send do compared with the six before it?',
  'Plan this week’s two emails from the current listings and draft the first one.',
  'Which listings have drawn the most clicks over the last 12 sends?',
  'Check the last four sends for hard bounces.',
];

export function ApprovalCard({ approval, onDecided, showThread }: { approval: Approval; onDecided?: () => void; showThread?: boolean }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      await api(`/approvals/${approval.id}/decide`, { body: { approve } });
    } catch {
      /* the card refreshes with whatever state it reached */
    }
    setBusy(null);
    onDecided?.();
  };
  const pending = approval.status === 'pending';
  const outcome: Record<string, string> = {
    approved: 'Approved, carrying it out',
    done: `Approved${approval.decided_via && approval.decided_via !== 'chat' ? ` by ${approval.decided_via}` : ''}, done`,
    rejected: 'Declined',
    failed: `Approved, but it failed${approval.result?.error ? `: ${approval.result.error}` : ''}`,
  };
  return (
    <div className={`approval${pending ? '' : ' decided'}`}>
      <div className="approval-kicker">
        <ShieldCheck /> {pending ? 'Needs your approval' : outcome[approval.status]}
        {showThread && approval.thread_title ? ` · ${approval.thread_title}` : ''}
      </div>
      <div className="approval-title">{approval.title}</div>
      {approval.summary && <div className="approval-summary">{approval.summary}</div>}
      {approval.action === 'connected_app_action' && approval.payload && <details className="app-action-details"><summary>Review action details</summary><pre>{JSON.stringify(approval.payload, null, 2)}</pre></details>}
      {pending && (
        <div className="approval-actions">
          <button className="btn accent sm" disabled={busy !== null} onClick={() => decide(true)}>
            <Check /> {busy === 'approve' ? 'Working' : 'Approve'}
          </button>
          <button className="btn sm" disabled={busy !== null} onClick={() => decide(false)}>
            <X /> Decline
          </button>
        </div>
      )}
    </div>
  );
}

function DeleteDialog({ title, onClose, onDelete }: { title: string; onClose: () => void; onDelete: (mode: 'list' | 'history') => void }) {
  const [mode, setMode] = useState<'list' | 'history'>('list');
  return (
    <Dialog title="Delete thread" onClose={onClose}>
      <p>What should happen to “{title}”?</p>
      <button className="choice" role="radio" aria-checked={mode === 'list'} onClick={() => setMode('list')}>
        <span className="radio" />
        <span>
          <div className="choice-title">Remove from my list</div>
          <div className="choice-sub">The thread leaves this screen. Its history is kept.</div>
        </span>
      </button>
      <button className="choice" role="radio" aria-checked={mode === 'history'} onClick={() => setMode('history')}>
        <span className="radio" />
        <span>
          <div className="choice-title">Delete the thread and its history</div>
          <div className="choice-sub">Every message and step in it is deleted for good. Anything already saved to memory stays.</div>
        </span>
      </button>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className={`btn ${mode === 'history' ? 'danger' : 'primary'}`} onClick={() => onDelete(mode)}>
          {mode === 'history' ? 'Delete for good' : 'Remove'}
        </button>
      </div>
    </Dialog>
  );
}

export function Thread() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { boot } = useApp();
  const detail = useData<ThreadDetail>(id ? `/threads/${id}` : null, ['message', 'step', 'job', 'approval', 'draft', 'thread'], id);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 1020);
  const [selectedDraft, setSelectedDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const data = id ? detail.data : null;
  const working = (data?.jobs.length ?? 0) > 0;
  const items = useMemo(() => (data ? timeline(data) : []), [data]);

  // Text arrives in pieces while the agent writes; the saved message replaces it when the run ends.
  useEffect(() => {
    setStreaming('');
    if (!id) return;
    return onLive((event) => {
      if (event.threadId !== id) return;
      if (event.type === 'delta' && event.text) setStreaming((s) => s + event.text);
      if (event.type === 'message' || (event.type === 'job' && event.status !== 'running')) setStreaming('');
    });
  }, [id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, streaming, working]);

  useEffect(() => {
    stick.current = true;
    setRenaming(null);
    setMenu(false);
    if (window.matchMedia('(min-width: 761px)').matches) input.current?.focus();
  }, [id]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // On a phone the thread's title and actions live in the top bar.
  const [mobileSlot, setMobileSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setMobileSlot(document.getElementById('mobile-actions'));
    const title = document.getElementById('mobile-title');
    if (title) title.textContent = data?.thread.title ?? (id ? '' : 'New thread');
  }, [data?.thread.title, id]);

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || sending) return;
    setSending(true);
    stick.current = true;
    try {
      if (!id) {
        const created = await api<{ thread: { id: string } }>('/threads', { body: { message: body } });
        setText('');
        navigate(`/t/${created.thread.id}`, { replace: true });
      } else {
        await api(`/threads/${id}/messages`, { body: { body } });
        setText('');
        void detail.reload();
      }
    } catch {
      /* keep the text so nothing is lost */
    }
    setSending(false);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const stop = () => id && api(`/threads/${id}/stop`, { body: {} }).then(detail.reload);
  const settle = () => id && api(`/threads/${id}/settle`, { body: {} }).then(detail.reload);
  const reopen = () => id && api(`/threads/${id}`, { method: 'PATCH', body: { status: 'open' } }).then(detail.reload);
  const rename = async () => {
    if (id && renaming?.trim()) await api(`/threads/${id}`, { method: 'PATCH', body: { title: renaming } });
    setRenaming(null);
    void detail.reload();
  };
  const remove = async (mode: 'list' | 'history') => {
    if (!id) return;
    await api(`/threads/${id}?mode=${mode}`, { method: 'DELETE' });
    navigate('/');
  };

  if (id && detail.error) {
    return (
      <div className="thread">
        <div className="empty" style={{ marginTop: '20vh' }}>
          {detail.error}
        </div>
      </div>
    );
  }

  const thread = data?.thread;
  const settled = thread?.status === 'settled';
  const agentOff = !boot.agent.enabled;
  const waitingForAgent = working && !boot.computer.agentOnline;

  const actions = thread && (
    <>
      {settled ? (
        <button className="btn ghost sm" onClick={reopen}>
          <RotateCcw /> <span className="hide-narrow">Reopen</span>
        </button>
      ) : (
        <button className="btn ghost sm" onClick={settle} disabled={working} title="Finish this thread and keep what is worth remembering">
          <CheckCheck /> <span className="hide-narrow">Settle</span>
        </button>
      )}
      <button className="icon-btn" aria-label={`${panelOpen ? 'Hide' : 'Show'} the agent's computer`} aria-expanded={panelOpen} title={`${panelOpen ? 'Hide' : 'Show'} ${boot.agent.name}'s computer`} onClick={() => setPanelOpen((v) => !v)}>
        <Monitor />
      </button>
      <span style={{ position: 'relative' }}>
        <button className="icon-btn" aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <MoreHorizontal />
        </button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button
              onClick={() => {
                setMenu(false);
                setRenaming(thread.title);
              }}
            >
              <FileText /> Rename
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenu(false);
                setDeleting(true);
              }}
            >
              <Trash2 /> Delete
            </button>
          </div>
        )}
      </span>
    </>
  );

  return (
    <>
      <section className="thread">
        <header className="thread-head">
          {renaming !== null ? (
            <input
              className="title-input"
              autoFocus
              value={renaming}
              aria-label="Thread title"
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => (e.key === 'Enter' ? void rename() : e.key === 'Escape' ? setRenaming(null) : undefined)}
            />
          ) : (
            <h1 onDoubleClick={() => thread && setRenaming(thread.title)}>{thread?.title ?? (id ? '' : 'New thread')}</h1>
          )}
          {thread?.series && <span className="chip">{thread.series}</span>}
          {settled && <span className="chip">Settled {thread?.settled_at ? shortDate(thread.settled_at) : ''}</span>}
          <span className="spacer" />
          {actions}
        </header>
        {mobileSlot && renaming === null && createPortal(actions, mobileSlot)}

        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="messages-inner">
            {!id && (
              <div className="welcome">
                <Mascot size={52} asleep={agentOff} />
                <h2>What should {boot.agent.name} work on?</h2>
                <p className="muted">
                  Ask about results, plan the next send, or have a draft written. You can also text{boot.channels.email ? ` or email ${boot.channels.email}` : ''}; it all lands in
                  the same threads.
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((item, index) => {
              if (item.kind === 'message') {
                const m = item.message;
                if (m.role === 'user') {
                  return (
                    <div className="msg-user" key={m.id}>
                      <div className="bubble">{m.body}</div>
                      <div className="msg-meta">
                        <ChannelTag channel={m.channel} /> · {clock(m.created_at)}
                      </div>
                    </div>
                  );
                }
                if (m.role === 'system') {
                  return (
                    <div className="msg-system" key={m.id}>
                      {m.body}
                    </div>
                  );
                }
                return (
                  <div className="msg-agent" key={m.id}>
                    <span className="avatar">
                      <Mascot size={24} />
                    </span>
                    <div className="text">
                      <Markdown>{m.body}</Markdown>
                      <div className="msg-meta">
                        {m.channel !== 'chat' && (
                          <>
                            Also sent by <ChannelTag channel={m.channel} /> ·
                          </>
                        )}
                        {clock(m.created_at)}
                      </div>
                    </div>
                  </div>
                );
              }
              if (item.kind === 'steps') {
                return (
                  <div className="steps" key={`steps-${index}`}>
                    {item.steps.map((s) => (
                      <div className="step" key={s.id}>
                        <span style={{ whiteSpace: 'nowrap' }}>{s.label}</span>
                        {s.detail && <span className="detail">{s.detail}</span>}
                      </div>
                    ))}
                  </div>
                );
              }
              if (item.kind === 'approval') return <ApprovalCard key={item.approval.id} approval={item.approval} onDecided={detail.reload} />;
              return (
                <button
                  className="draft-pill"
                  key={item.draft.id}
                  onClick={() => {
                    setSelectedDraft(item.draft.id);
                    setPanelOpen(true);
                  }}
                >
                  <span className="icon">
                    <FileText />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div className="row-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.draft.subject}
                    </div>
                    <div className="row-sub">
                      Draft{item.draft.send_on ? ` for ${shortDate(item.draft.send_on)}` : ''} ·{' '}
                      {liveSendLabel(item.draft.status) || (item.draft.status === 'uploaded' ? (boot.demoMode ? 'Simulated Zoho draft' : 'In Zoho as a draft') : item.draft.status === 'tested' ? (boot.demoMode ? 'Test simulated' : 'Test sent to you') : 'Not uploaded')}
                    </div>
                  </span>
                  <span className="chip accent">Preview</span>
                </button>
              );
            })}

            {streaming.trim() && (
              <div className="msg-agent">
                <span className="avatar">
                  <Mascot size={24} working />
                </span>
                <div className="text">
                  <Markdown>{streaming}</Markdown>
                </div>
              </div>
            )}
            {working && !streaming.trim() && (
              <div className="working-line">
                <span className="dots">
                  <span />
                  <span />
                  <span />
                </span>
                {agentOff
                  ? `${boot.agent.name} is switched off. This will start when you turn it back on.`
                  : waitingForAgent
                    ? `Waking ${boot.agent.name}'s computer`
                    : `${boot.agent.name} is working`}
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={input}
              rows={1}
              value={text}
              placeholder={settled ? 'Send a message to reopen this thread' : `Message ${boot.agent.name}`}
              aria-label={`Message ${boot.agent.name}`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            <div className="composer-foot">
              <span className="hint">{agentStateText(boot)}</span>
              {working && !text.trim() ? (
                <button className="send stop" aria-label="Stop" title="Stop" onClick={stop}>
                  <Square />
                </button>
              ) : (
                <button className="send" aria-label="Send" disabled={!text.trim() || sending} onClick={() => void send()}>
                  <ArrowUp />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <ComputerPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        drafts={data?.drafts ?? []}
        steps={data?.steps ?? []}
        selectedDraft={selectedDraft}
        onSelectDraft={setSelectedDraft}
        working={working}
        onAsk={(message) => void send(message)}
      />

      {deleting && thread && <DeleteDialog title={thread.title} onClose={() => setDeleting(false)} onDelete={remove} />}
    </>
  );
}
