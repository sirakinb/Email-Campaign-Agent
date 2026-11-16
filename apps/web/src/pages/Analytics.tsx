import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info } from 'lucide-react';
import { int, pct, shortDate, useData, type Averages, type Send } from '../api';
import { BarList, ColumnChart, Delta, Segmented } from '../components/bits';
import { useApp } from '../App';

type AnalyticsData = {
  latest: Send | null;
  previousAverage: Averages;
  periodAverage: Averages;
  sends: Send[];
  clicksByKind: { kind: string; clicks: number }[];
  topListings: { listing_id: string | null; address: string | null; url: string; clicks: number; sends: number }[];
  detailedCount: number;
};

const KIND_LABEL: Record<string, string> = {
  listing: 'A specific listing',
  all_rentals: 'All rentals page',
  other: 'Other links',
  preferences: 'Email preferences',
};

export function Analytics() {
  const { boot } = useApp();
  const navigate = useNavigate();
  const [count, setCount] = useState('12');
  const [metric, setMetric] = useState<'click' | 'open'>('click');
  const analytics = useData<AnalyticsData>(`/analytics?count=${count}`, ['sync']);
  const data = analytics.data;
  if (!data) return <div className="page" />;
  if (!data.sends.length) {
    return (
      <div className="page">
        <div className="page-inner">
          <h1 className="page-title">Analytics</h1>
          <div className="card" style={{ marginTop: 24 }}>
            <div className="empty">No sends have been synced from Zoho yet.</div>
          </div>
        </div>
      </div>
    );
  }

  const chronological = [...data.sends].reverse();
  const average = metric === 'click' ? data.periodAverage.click_rate : data.periodAverage.open_rate;
  const totalClicks = data.clicksByKind.reduce((sum, k) => sum + k.clicks, 0);
  const latest = data.latest!;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Analytics</h1>
            <p className="page-sub">
              Opens and clicks for sends to the main list, {shortDate(chronological[0]?.send_date)} to {shortDate(latest.send_date, true)}.
            </p>
          </div>
          <Segmented
            value={count}
            options={[
              { value: '6', label: 'Last 6' },
              { value: '12', label: 'Last 12' },
              { value: '24', label: 'Last 24' },
            ]}
            onChange={setCount}
          />
        </div>

        <div className="tiles">
          <div className="tile">
            <div className="tile-label">Click rate</div>
            <div className="tile-value">{pct(data.periodAverage.click_rate)}</div>
            <div className="tile-foot">
              Latest {pct(latest.click_rate)} · <Delta value={latest.click_rate} base={data.previousAverage.click_rate} />
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">Open rate, all opens</div>
            <div className="tile-value">{pct(data.periodAverage.open_rate)}</div>
            <div className="tile-foot">
              Latest {pct(latest.open_rate)} · <Delta value={latest.open_rate} base={data.previousAverage.open_rate} />
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">Opens by a person</div>
            <div className="tile-value">{pct(data.periodAverage.reliable_open_rate)}</div>
            <div className="tile-foot">
              {data.detailedCount < data.sends.length ? `From the ${data.detailedCount} sends with a detailed report` : 'Leaves out Apple Mail automatic opens'}
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">Clicks per open</div>
            <div className="tile-value">{pct(data.periodAverage.click_to_open_rate)}</div>
            <div className="tile-foot">
              {int(data.periodAverage.sent)} emails over {data.periodAverage.sends} sends
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-head">
            <span className="card-title">{metric === 'click' ? 'Click rate by send' : 'Open rate by send'}</span>
            <Segmented
              value={metric}
              options={[
                { value: 'click', label: 'Clicks' },
                { value: 'open', label: 'Opens' },
              ]}
              onChange={setMetric}
            />
          </div>
          <div className="card-body">
            <ColumnChart
              average={average}
              onSelect={(key) => navigate(`/campaigns/${key}`)}
              points={chronological.map((s) => ({
                key: s.id,
                label: s.send_date ? new Date(`${s.send_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
                value: metric === 'click' ? s.click_rate : s.open_rate,
                second: metric === 'open' ? s.reliable_open_rate : undefined,
                title: `${s.subject ?? s.name}\n${shortDate(s.send_date)}: ${metric === 'click' ? `${pct(s.click_rate)} click rate, ${int(s.clicks)} clicks` : `${pct(s.open_rate)} all opens${s.reliable_open_rate != null ? `, ${pct(s.reliable_open_rate)} by a person` : ''}`}`,
              }))}
            />
            {metric === 'open' && (
              <div className="legend" style={{ marginTop: 8 }}>
                <span>
                  <i style={{ background: 'var(--accent)', opacity: 0.38 }} />
                  All opens, including Apple Mail automatic opens
                </span>
                <span>
                  <i style={{ background: 'var(--accent)' }} />
                  Opens by a person
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="grid-even" style={{ marginTop: 12 }}>
          <div className="card">
            <div className="card-head">
              <span className="card-title">Where the clicks went</span>
              <span className="note">{int(totalClicks)} unique clicks</span>
            </div>
            <div className="card-body">
              {totalClicks ? (
                <BarList
                  rows={data.clicksByKind.map((k) => ({ label: KIND_LABEL[k.kind] ?? k.kind, value: Math.round((1000 * k.clicks) / totalClicks) / 10 }))}
                  format={(v) => `${v}%`}
                />
              ) : (
                <p className="muted">Link detail has not been synced for these sends yet.</p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <span className="card-title">Most clicked listings</span>
              <span className="note">Unique clicks</span>
            </div>
            <div className="card-body">
              {data.topListings.length ? (
                <BarList rows={data.topListings.map((l) => ({ label: l.address ?? 'No longer on the listings page', value: l.clicks, href: l.url }))} />
              ) : (
                <p className="muted">Link detail has not been synced for these sends yet.</p>
              )}
            </div>
          </div>
        </div>

        <h2 className="section-title">Sends</h2>
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th className="r hide-narrow">Sent</th>
                <th className="r hide-narrow">All opens</th>
                <th className="r hide-narrow">By a person</th>
                <th className="r">Clicks</th>
                <th className="r">Click rate</th>
              </tr>
            </thead>
            <tbody>
              {data.sends.map((s) => (
                <tr key={s.id} className="link" onClick={() => navigate(`/campaigns/${s.id}`)}>
                  <td>
                    <div className="name">{s.subject ?? s.theme ?? s.name}</div>
                    <div className="sub">
                      {shortDate(s.send_date)}
                      {s.series ? ` · ${s.series}${s.email_number ? `, email ${s.email_number}` : ''}` : ''}
                    </div>
                  </td>
                  <td className="r hide-narrow">{int(s.sent)}</td>
                  <td className="r hide-narrow">{pct(s.open_rate)}</td>
                  <td className="r hide-narrow">{pct(s.reliable_open_rate)}</td>
                  <td className="r">{int(s.clicks)}</td>
                  <td className="r">{pct(s.click_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="note" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Info size={13} style={{ marginTop: 2, flex: 'none' }} />
          {boot.demoMode ? 'Invented results for the demo. Rates are unique opens or clicks divided by emails sent. All opens include simulated Apple Mail privacy opens.' : 'Rates are unique opens or clicks over emails sent, worked out here because Zoho’s own rates are unreliable on this account. Most opens are Apple Mail opening messages automatically, so treat “all opens” as an upper bound. Bookings and leases are tracked in Buildium and are not shown.'}
        </p>
      </div>
    </div>
  );
}
