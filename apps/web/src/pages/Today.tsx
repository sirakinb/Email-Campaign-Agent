import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, Info, Plus, RefreshCw } from 'lucide-react';
import { ago, api, int, pct, shortDate, until, useData, type Approval, type Averages, type Draft, type Send } from '../api';
import { ApprovalCard } from './Thread';
import { Delta } from '../components/bits';
import { useApp } from '../App';

type TodayData = {
  approvals: Approval[];
  drafts: Draft[];
  memories: { id: string; title: string; body: string; created_at: string; source_thread_id: string | null }[];
  schedule: { id: string; label: string; description: string; next_run_at: string | null; last_run_at: string | null; last_status: string | null }[];
  latest: Send | null;
  previousAverage: Averages;
  recent: Send[];
  sync: { source: string; status: string; detail: string | null; rows: number | null; finished_at: string | null }[];
  syncRunning: boolean;
  listings: { active: number; fresh: number; flagged: number };
};

export function Today() {
  const { boot } = useApp();
  const navigate = useNavigate();
  const today = useData<TodayData>('/today', ['approval', 'draft', 'sync', 'threads']);
  const data = today.data;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (!data) return <div className="page" />;
  const latest = data.latest;
  const zoho = data.sync.find((s) => s.source === 'zoho_campaigns');
  const inZoho = data.drafts.filter((d) => d.status === 'uploaded');
  const inProgress = data.drafts.filter((d) => d.status !== 'uploaded');

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Today</h1>
            <p className="page-sub">{date}</p>
          </div>
          <button className="btn primary" onClick={() => navigate('/new')}>
            <Plus /> New thread
          </button>
        </div>

        <h2 className="section-title">Needs you{data.approvals.length ? ` (${data.approvals.length})` : ''}</h2>
        {data.approvals.length ? (
          <div className="stack">
            {data.approvals.map((a) => (
              <div key={a.id} style={{ marginLeft: -36 }}>
                <ApprovalCard approval={a} showThread onDecided={today.reload} />
              </div>
            ))}
          </div>
        ) : (
          <div className="card">
            <div className="empty">Nothing is waiting on you.</div>
          </div>
        )}

        {inZoho.length > 0 && (
          <>
            <h2 className="section-title">{boot.demoMode ? 'Simulated draft handoffs' : 'Ready in Zoho for you to send'}</h2>
            <div className="card">
              {inZoho.map((d) => (
                <DraftRow key={d.id} draft={d} note={boot.demoMode ? 'Simulation completed in this demo. No real Zoho account was changed.' : 'Saved in Zoho Campaigns as a draft. Schedule or send it there.'} />
              ))}
            </div>
          </>
        )}

        {inProgress.length > 0 && (
          <>
            <h2 className="section-title">Drafts in progress</h2>
            <div className="card">
              {inProgress.map((d) => (
                <DraftRow key={d.id} draft={d} note={d.status === 'tested' ? (boot.demoMode ? 'Test simulated. No email was delivered.' : 'A test was sent to your inbox.') : 'Written here, not yet uploaded.'} />
              ))}
            </div>
          </>
        )}

        <h2 className="section-title">Latest send</h2>
        {latest ? (
          <>
            <Link to={`/campaigns/${latest.id}`} className="card row" style={{ borderTop: 0, marginBottom: 12 }}>
              <div className="row-main">
                <div className="row-title">{latest.subject ?? latest.name}</div>
                <div className="row-sub">
                  {shortDate(latest.send_date, true)}
                  {latest.series ? ` · ${latest.series}${latest.email_number ? `, email ${latest.email_number}` : ''}` : ''} · {int(latest.sent)} sent
                </div>
              </div>
              <ArrowRight size={16} className="muted" />
            </Link>
            <div className="tiles">
              <div className="tile">
                <div className="tile-label">Click rate</div>
                <div className="tile-value">{pct(latest.click_rate)}</div>
                <div className="tile-foot">
                  {int(latest.clicks)} clicks · <Delta value={latest.click_rate} base={data.previousAverage.click_rate} />
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Open rate, all opens</div>
                <div className="tile-value">{pct(latest.open_rate)}</div>
                <div className="tile-foot">
                  <Delta value={latest.open_rate} base={data.previousAverage.open_rate} />
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Opens by a person</div>
                <div className="tile-value">{pct(latest.reliable_open_rate)}</div>
                <div className="tile-foot">
                  {latest.reliable_open_rate == null ? 'Not in the synced report yet' : <Delta value={latest.reliable_open_rate} base={data.previousAverage.reliable_open_rate} />}
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Unsubscribes</div>
                <div className="tile-value">{latest.detailed ? int(latest.optout) : '–'}</div>
                <div className="tile-foot">{latest.detailed ? `${int(latest.hard_bounced)} hard bounces` : 'Not in the synced report yet'}</div>
              </div>
            </div>
            <p className="note" style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <Info size={13} style={{ marginTop: 2, flex: 'none' }} />
              {boot.demoMode ? 'These results are invented. All opens include simulated Apple Mail privacy opens; clicks provide a clearer comparison.' : 'Most opens are Apple Mail opening messages automatically, so “all opens” overstates readership. Clicks are the truer signal.'}
            </p>
          </>
        ) : (
          <div className="card">
            <div className="empty">No sends have been synced from Zoho yet.</div>
          </div>
        )}

        <div className="grid-even" style={{ marginTop: 28 }}>
          <div>
            <h2 className="section-title" style={{ marginTop: 0 }}>
              Coming up
            </h2>
            <div className="card">
              {data.schedule.map((s) => (
                <div className="row" key={s.id}>
                  <div className="row-main">
                    <div className="row-title">{s.label}</div>
                    <div className="row-sub">{s.description}</div>
                  </div>
                  <span className="note" style={{ whiteSpace: 'nowrap' }}>
                    {until(s.next_run_at)}
                  </span>
                </div>
              ))}
              {!data.schedule.length && <div className="empty">No automations are switched on.</div>}
            </div>
          </div>
          <div>
            <h2 className="section-title" style={{ marginTop: 0 }}>
              Data
            </h2>
            <div className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{int(data.listings.active)} homes on the listings page</div>
                  <div className="row-sub">
                    {data.listings.fresh} new in the last 7 days
                    {data.listings.flagged ? ` · ${data.listings.flagged} with something to check` : ''}
                  </div>
                </div>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">{boot.demoMode ? 'Fictional campaign history' : 'Zoho Campaigns'}</div>
                  <div className="row-sub">
                    {zoho ? `${int(zoho.rows)} campaigns, synced ${ago(zoho.finished_at)}${zoho.detail ? `. ${zoho.detail}` : ''}` : 'Not synced yet'}
                  </div>
                </div>
                <button className="btn sm" disabled={data.syncRunning} onClick={() => api('/sync', { body: {} }).then(today.reload)}>
                  <RefreshCw /> {data.syncRunning ? 'Syncing' : 'Sync now'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {data.memories.length > 0 && (
          <>
            <h2 className="section-title">Recently remembered</h2>
            <div className="card">
              {data.memories.map((m) => (
                <div className="row" key={m.id}>
                  <div className="row-main">
                    <div className="row-title">{m.title}</div>
                    <div className="row-sub">{m.body}</div>
                  </div>
                  <span className="note" style={{ whiteSpace: 'nowrap' }}>
                    {ago(m.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="note" style={{ marginTop: 28 }}>
          {boot.demoMode ? 'Penny reasons and drafts live using invented data. Zoho uploads and email delivery are simulated.' : `${boot.agent.name} writes drafts and uploads them to Zoho Campaigns as drafts. Nothing is sent to the list from here.`}
        </p>
      </div>
    </div>
  );
}

function DraftRow({ draft, note }: { draft: Draft; note: string }) {
  const inner = (
    <>
      <span className="draft-pill" style={{ width: 'auto', margin: 0, padding: 0, border: 0, background: 'none' }}>
        <span className="icon">
          <FileText />
        </span>
      </span>
      <div className="row-main">
        <div className="row-title">{draft.subject}</div>
        <div className="row-sub">
          {draft.send_on ? `Planned for ${shortDate(draft.send_on)} · ` : ''}
          {note}
        </div>
      </div>
      <ArrowRight size={16} className="muted" />
    </>
  );
  return draft.thread_id ? (
    <Link className="row" to={`/t/${draft.thread_id}`}>
      {inner}
    </Link>
  ) : (
    <div className="row">{inner}</div>
  );
}
