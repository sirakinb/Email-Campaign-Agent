import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { api, int, pct, shortDate, useData, type Draft, type Send } from '../api';
import { Segmented } from '../components/bits';
import { useApp } from '../App';

type Group = { key: string; title: string; sub: string; sends: Send[]; isSeries: boolean };

/** Named series stay together; everything else is grouped by the month it went out. */
function groupSends(sends: Send[]): Group[] {
  const groups = new Map<string, Group>();
  for (const send of sends) {
    const month = send.send_date ? send.send_date.slice(0, 7) : 'undated';
    const key = send.series ? `series:${send.series}` : `month:${month}`;
    let group = groups.get(key);
    if (!group) {
      const title = send.series
        ? send.series
        : month === 'undated'
          ? 'Undated'
          : new Date(`${month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      group = { key, title, sub: '', sends: [], isSeries: Boolean(send.series) };
      groups.set(key, group);
    }
    group.sends.push(send);
  }
  return [...groups.values()].map((group) => {
    const sent = group.sends.filter((s) => s.status === 'sent' && s.sent > 0);
    const total = sent.reduce((sum, s) => sum + s.sent, 0);
    const clicks = sent.reduce((sum, s) => sum + s.clicks, 0);
    const dates = group.sends.map((s) => s.send_date).filter(Boolean).sort() as string[];
    const range = dates.length ? (dates[0] === dates[dates.length - 1] ? shortDate(dates[0]) : `${shortDate(dates[0])} to ${shortDate(dates[dates.length - 1])}`) : '';
    return {
      ...group,
      sub: [`${group.sends.length} ${group.sends.length === 1 ? 'email' : 'emails'}`, group.isSeries ? range : '', total ? `${pct((100 * clicks) / total)} click rate` : '']
        .filter(Boolean)
        .join(' · '),
    };
  });
}

export function Campaigns() {
  const { boot } = useApp();
  const navigate = useNavigate();
  const [year, setYear] = useState<number | null>(null);
  const list = useData<{ year: number; years: number[]; sends: Send[]; drafts: Draft[] }>(`/campaigns${year ? `?year=${year}` : ''}`, ['sync', 'draft']);
  const groups = useMemo(() => groupSends(list.data?.sends ?? []), [list.data]);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const data = list.data;

  const plan = async () => {
    const created = await api<{ thread: { id: string } }>('/threads', {
      body: { title: 'Plan the next sends', message: 'Plan the next two emails from the current listings. Tell me the angle for each and which homes you would feature, then draft the first one.' },
    });
    navigate(`/t/${created.thread.id}`);
  };

  if (!data) return <div className="page" />;
  const years = data.years.length ? data.years : [data.year];

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Campaigns</h1>
            <p className="page-sub">
              {boot.demoMode ? 'Invented campaign history, grouped by series. Live demo drafts appear at the top.' : `Every email sent from Zoho Campaigns, grouped by series. ${boot.agent.name}’s drafts appear at the top until they are sent.`}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Segmented value={String(data.year)} options={years.slice(0, 5).map((y) => ({ value: String(y), label: String(y) }))} onChange={(v) => setYear(Number(v))} />
            <button className="btn primary" onClick={plan}>
              <Plus /> Plan the next sends
            </button>
          </div>
        </div>

        {data.drafts.length > 0 && (
          <>
            <h2 className="section-title">In the works</h2>
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <tbody>
                  {data.drafts.map((d) => (
                    <tr key={d.id} className={d.thread_id ? 'link' : ''} onClick={() => d.thread_id && navigate(`/t/${d.thread_id}`)}>
                      <td>
                        <div className="name">{d.subject}</div>
                        <div className="sub">
                          {d.name}
                          {d.subject_b ? ` · Alternative: ${d.subject_b}` : ''}
                        </div>
                      </td>
                      <td className="r hide-narrow">{d.send_on ? shortDate(d.send_on) : 'No date yet'}</td>
                      <td className="r">
                        <span className={`chip ${d.status === 'uploaded' ? 'good' : d.status === 'tested' ? 'accent' : ''}`}>
                          {d.status === 'uploaded' ? (boot.demoMode ? 'Simulated Zoho draft' : 'In Zoho as a draft') : d.status === 'tested' ? (boot.demoMode ? 'Test simulated' : 'Test sent') : 'Draft here'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2 className="section-title">Sent in {data.year}</h2>
        {groups.length ? (
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
                {groups.map((group, index) => {
                  const open = toggled[group.key] ?? index < 3;
                  return [
                    <tr key={group.key} className="series-row link" onClick={() => setToggled((t) => ({ ...t, [group.key]: !open }))}>
                      <td colSpan={5}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {group.title}
                          {group.isSeries && <span className="chip accent">Series</span>}
                          <span className="muted note">{group.sub}</span>
                        </span>
                      </td>
                    </tr>,
                    ...(open
                      ? group.sends.map((s) => (
                          <tr key={s.id} className="link" onClick={() => navigate(`/campaigns/${s.id}`)}>
                            <td>
                              <div className="name">
                                <Link to={`/campaigns/${s.id}`} onClick={(e) => e.stopPropagation()}>
                                  {s.subject ?? s.theme ?? s.name}
                                </Link>
                              </div>
                              <div className="sub">
                                {shortDate(s.send_date)}
                                {s.email_number ? ` · Email ${s.email_number}` : ''}
                                {s.subject && s.theme ? ` · ${s.theme}` : ''}
                                {s.status !== 'sent' ? ` · ${s.status === 'draft' ? 'Draft in Zoho' : s.status}` : ''}
                              </div>
                            </td>
                            <td className="r hide-narrow">{s.status === 'sent' ? int(s.sent) : '–'}</td>
                            <td className="r hide-narrow">{s.status === 'sent' ? pct(s.open_rate) : '–'}</td>
                            <td className="r">{s.status === 'sent' ? int(s.clicks) : '–'}</td>
                            <td className="r">{s.status === 'sent' ? pct(s.click_rate) : '–'}</td>
                          </tr>
                        ))
                      : []),
                  ];
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card">
            <div className="empty">No campaigns synced for {data.year}.</div>
          </div>
        )}
        <p className="note" style={{ marginTop: 10 }}>
          Rates are unique opens or clicks over emails sent, worked out here. Opens include Apple Mail automatic opens.
        </p>
      </div>
    </div>
  );
}
