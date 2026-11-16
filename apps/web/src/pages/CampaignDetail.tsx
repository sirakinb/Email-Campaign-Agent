import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquarePlus } from 'lucide-react';
import { api, int, pct, shortDate, useData, type Averages, type Send } from '../api';
import { BarList, Delta } from '../components/bits';
import { useApp } from '../App';

type Detail = {
  send: Send;
  campaign: { sender_email: string | null; sender_name: string | null; list_names: string[]; topic_name: string | null; preheader: string | null };
  links: { label: string; kind: string; url: string; clicks: number; listing_id: string | null }[];
  previous: Send[];
  previousAverage: Averages;
  draft: { id: string; thread_id: string | null } | null;
};

export function CampaignDetail() {
  const { id } = useParams();
  const { boot } = useApp();
  const navigate = useNavigate();
  const detail = useData<Detail>(`/campaigns/${id}`, ['sync']);
  if (detail.error) {
    return (
      <div className="page">
        <div className="empty" style={{ marginTop: '20vh' }}>
          {detail.error}
        </div>
      </div>
    );
  }
  if (!detail.data) return <div className="page" />;
  const { send, campaign, links, previous, previousAverage, draft } = detail.data;
  const sent = send.status === 'sent';

  const ask = async () => {
    const created = await api<{ thread: { id: string } }>('/threads', {
      body: {
        title: `Review: ${send.subject ?? send.name}`.slice(0, 80),
        message: `Review the send "${send.name}" (campaign ${send.id}). Compare it with the six before it, say what likely helped or hurt, and what you would change next time.`,
      },
    });
    navigate(`/t/${created.thread.id}`);
  };

  return (
    <div className="page">
      <div className="page-inner">
        <Link to="/campaigns" className="btn ghost sm" style={{ marginLeft: -10, marginBottom: 10 }}>
          <ArrowLeft /> Campaigns
        </Link>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title">{send.subject ?? send.name}</h1>
            <p className="page-sub">{send.name}</p>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <span className={`chip ${sent ? 'good' : ''}`}>{sent ? `Sent ${shortDate(send.send_date, true)}` : send.status === 'draft' ? 'Draft in Zoho' : send.status}</span>
              {send.series && (
                <span className="chip accent">
                  {send.series}
                  {send.email_number ? `, email ${send.email_number}` : ''}
                </span>
              )}
              {campaign?.list_names?.map((name) => (
                <span className="chip" key={name}>
                  {name} list
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {draft?.thread_id && (
              <Link className="btn" to={`/t/${draft.thread_id}`}>
                Open its thread
              </Link>
            )}
            <button className="btn primary" onClick={ask}>
              <MessageSquarePlus /> Ask {boot.agent.name} about this
            </button>
          </div>
        </div>

        {sent ? (
          <>
            <div className="tiles">
              <div className="tile">
                <div className="tile-label">Click rate</div>
                <div className="tile-value">{pct(send.click_rate)}</div>
                <div className="tile-foot">
                  {int(send.clicks)} clicks · <Delta value={send.click_rate} base={previousAverage.click_rate} />
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Open rate, all opens</div>
                <div className="tile-value">{pct(send.open_rate)}</div>
                <div className="tile-foot">
                  {int(send.opens)} opens · <Delta value={send.open_rate} base={previousAverage.open_rate} />
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Opens by a person</div>
                <div className="tile-value">{pct(send.reliable_open_rate)}</div>
                <div className="tile-foot">
                  {send.opens_reliable == null ? 'Detailed report not synced yet' : <Delta value={send.reliable_open_rate} base={previousAverage.reliable_open_rate} />}
                </div>
              </div>
              <div className="tile">
                <div className="tile-label">Emails sent</div>
                <div className="tile-value">{int(send.sent)}</div>
                <div className="tile-foot">{send.detailed ? `${int(send.optout)} unsubscribes · ${int(send.hard_bounced)} hard bounces` : 'Bounces not synced yet'}</div>
              </div>
            </div>

            <div className="grid-2" style={{ marginTop: 12 }}>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Where the clicks went</span>
                  <span className="note">Unique clicks</span>
                </div>
                <div className="card-body">
                  {links.length ? (
                    <BarList rows={links.filter((l) => l.kind !== 'preferences').map((l) => ({ label: l.label, value: l.clicks, href: l.url.startsWith('http') ? l.url : undefined }))} />
                  ) : (
                    <p className="muted">The link breakdown for this send has not been synced yet.</p>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Details</span>
                </div>
                <div className="card-body" style={{ display: 'grid', gap: 10 }}>
                  <Field label="Subject" value={send.subject ?? 'Not synced yet'} />
                  {campaign?.preheader ? <Field label="Preview text" value={campaign.preheader} /> : null}
                  <Field label="From" value={campaign?.sender_name ? `${campaign.sender_name} (${campaign.sender_email})` : 'Not synced yet'} />
                  <Field label="Topic" value={campaign?.topic_name ?? 'Not synced yet'} />
                  <p className="note">Zoho does not return a sent email’s content, so there is no preview for emails written outside the command center.</p>
                </div>
              </div>
            </div>

            <h2 className="section-title">The six before it</h2>
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th className="r hide-narrow">Sent</th>
                    <th className="r hide-narrow">Opens</th>
                    <th className="r">Clicks</th>
                    <th className="r">Click rate</th>
                  </tr>
                </thead>
                <tbody>
                  {previous.map((s) => (
                    <tr key={s.id} className="link" onClick={() => navigate(`/campaigns/${s.id}`)}>
                      <td>
                        <div className="name">{s.subject ?? s.theme ?? s.name}</div>
                        <div className="sub">{shortDate(s.send_date)}</div>
                      </td>
                      <td className="r hide-narrow">{int(s.sent)}</td>
                      <td className="r hide-narrow">{pct(s.open_rate)}</td>
                      <td className="r">{int(s.clicks)}</td>
                      <td className="r">{pct(s.click_rate)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">Average of these</td>
                    <td className="r hide-narrow muted">{int(Math.round(previousAverage.sent / Math.max(previousAverage.sends, 1)))}</td>
                    <td className="r hide-narrow muted">{pct(previousAverage.open_rate)}</td>
                    <td className="r muted" />
                    <td className="r muted">{pct(previousAverage.click_rate)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="card">
            <div className="empty">This campaign has not been sent, so there are no results yet. It is sent from Zoho.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="note">{label}</div>
      <div style={{ color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}
