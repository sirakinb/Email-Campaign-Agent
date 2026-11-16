import { sql } from '../db.js';

/**
 * Read models over the synced copy of Zoho and the listings page.
 *
 * Rates are computed here as unique opens or clicks over emails sent. Zoho's
 * own rates are not used: on this account "delivered" exceeds "sent".
 * `open_rate` counts every open, including Apple Mail's automatic ones;
 * `reliable_open_rate` counts only opens Zoho attributes to a person.
 */
export type Send = {
  id: string;
  name: string;
  status: string;
  subject: string | null;
  send_date: string | null;
  series: string | null;
  email_number: number | null;
  theme: string | null;
  sent: number;
  opens: number;
  opens_reliable: number | null;
  opens_mpp: number | null;
  clicks: number;
  hard_bounced: number;
  soft_bounced: number;
  optout: number;
  detailed: boolean;
  open_rate: number | null;
  reliable_open_rate: number | null;
  click_rate: number | null;
  click_to_open_rate: number | null;
};

const SEND_COLUMNS = sql`
  c.id, c.name, c.status, c.subject, c.series, c.email_number, c.theme,
  coalesce(c.send_date, c.created_at::date) as send_date,
  coalesce(r.sent, 0) as sent, coalesce(r.opens, 0) as opens, r.opens_reliable, r.opens_mpp,
  coalesce(r.clicks, 0) as clicks, coalesce(r.hard_bounced, 0) as hard_bounced,
  coalesce(r.soft_bounced, 0) as soft_bounced, coalesce(r.optout, 0) as optout,
  coalesce(r.detailed, false) as detailed,
  round(100.0 * r.opens / nullif(r.sent, 0), 2)::float as open_rate,
  round(100.0 * r.opens_reliable / nullif(r.sent, 0), 2)::float as reliable_open_rate,
  round(100.0 * r.clicks / nullif(r.sent, 0), 2)::float as click_rate,
  round(100.0 * r.clicks / nullif(r.opens, 0), 2)::float as click_to_open_rate`;

export async function listSends(options: { limit?: number; status?: string; year?: number; minSent?: number } = {}): Promise<Send[]> {
  return sql<Send[]>`
    select ${SEND_COLUMNS}
    from zoho_campaigns c left join zoho_reports r on r.campaign_id = c.id
    where true
      ${options.status ? sql`and c.status = ${options.status}` : sql``}
      ${options.year ? sql`and extract(year from coalesce(c.send_date, c.created_at::date)) = ${options.year}` : sql``}
      ${options.minSent ? sql`and coalesce(r.sent, 0) >= ${options.minSent}` : sql``}
    order by coalesce(c.send_date, c.created_at::date) desc nulls last, c.created_at desc
    limit ${options.limit ?? 500}`;
}

export async function getSend(id: string): Promise<Send | null> {
  const [send] = await sql<Send[]>`
    select ${SEND_COLUMNS}
    from zoho_campaigns c left join zoho_reports r on r.campaign_id = c.id
    where c.id = ${id}`;
  return send ?? null;
}

export type LinkGroup = { label: string; kind: 'listing' | 'all_rentals' | 'preferences' | 'other'; url: string; clicks: number; listing_id: string | null };

/** Clicks per destination. Zoho reports each link position separately; this adds them up and names them. */
export async function linkGroups(campaignId: string): Promise<LinkGroup[]> {
  const rows = await sql<{ url: string; clicks: number; listing_id: string | null; address: string | null }[]>`
    select l.url, sum(l.unique_clicks)::int as clicks, li.id as listing_id, li.address
    from zoho_links l
    left join listings li on l.url like '%' || li.id || '%'
    where l.campaign_id = ${campaignId}
    group by l.url, li.id, li.address
    order by clicks desc`;
  return rows.map((row) => {
    if (row.url.startsWith('$[')) return { label: 'Email preferences', kind: 'preferences', url: row.url, clicks: row.clicks, listing_id: null };
    if (row.listing_id || /appfolio\.com\/listings\/detail\//.test(row.url)) {
      return { label: row.address ?? 'A listing no longer on the site', kind: 'listing', url: row.url, clicks: row.clicks, listing_id: row.listing_id };
    }
    if (/reinfo411\.com|appfolio\.com\/listings\/?$/.test(row.url)) {
      return { label: 'All rentals page', kind: 'all_rentals', url: row.url, clicks: row.clicks, listing_id: null };
    }
    return { label: row.url.replace(/^https?:\/\//, '').slice(0, 60), kind: 'other', url: row.url, clicks: row.clicks, listing_id: null };
  });
}

export type Averages = { sends: number; sent: number; open_rate: number | null; reliable_open_rate: number | null; click_rate: number | null; click_to_open_rate: number | null };

/** Averages across a set of sends, weighted by volume. */
export function averageOf(sends: Send[]): Averages {
  const total = (pick: (s: Send) => number | null) => sends.reduce((sum, s) => sum + (pick(s) ?? 0), 0);
  const sent = total((s) => s.sent);
  const opens = total((s) => s.opens);
  const reliableSends = sends.filter((s) => s.opens_reliable != null);
  const reliableSent = reliableSends.reduce((sum, s) => sum + s.sent, 0);
  const rate = (n: number, d: number) => (d > 0 ? Math.round((10000 * n) / d) / 100 : null);
  return {
    sends: sends.length,
    sent,
    open_rate: rate(opens, sent),
    reliable_open_rate: rate(reliableSends.reduce((sum, s) => sum + (s.opens_reliable ?? 0), 0), reliableSent),
    click_rate: rate(total((s) => s.clicks), sent),
    click_to_open_rate: rate(total((s) => s.clicks), opens),
  };
}

/** Real sends to the main list, newest first. Leaves out tests and small one-off sends. */
export async function mainSends(limit = 60): Promise<Send[]> {
  return listSends({ status: 'sent', minSent: 1000, limit });
}

export async function analytics(count = 12) {
  const sends = (await mainSends(count + 6)).slice(0, count);
  const latest = sends[0] ?? null;
  const previous = sends.slice(1, 7);
  const linkRows = sends.length
    ? await sql<{ kind: string; clicks: number }[]>`
        select case
            when l.url like '$[%' then 'preferences'
            when l.url ~ 'appfolio\\.com/listings/detail/|/demo/properties/demo-' then 'listing'
            when l.url ~ 'reinfo411\\.com|appfolio\\.com/listings/?$' then 'all_rentals'
            else 'other' end as kind,
          sum(l.unique_clicks)::int as clicks
        from zoho_links l where l.campaign_id in ${sql(sends.map((s) => s.id))}
        group by 1 order by 2 desc`
    : [];
  const topListings = sends.length
    ? await sql<{ listing_id: string | null; address: string | null; url: string; clicks: number; sends: number }[]>`
        select li.id as listing_id, li.address, l.url, sum(l.unique_clicks)::int as clicks, count(distinct l.campaign_id)::int as sends
        from zoho_links l left join listings li on l.url like '%' || li.id || '%'
        where l.campaign_id in ${sql(sends.map((s) => s.id))} and (li.id is not null or l.url ~ 'appfolio\\.com/listings/detail/')
        group by li.id, li.address, l.url order by clicks desc limit 8`
    : [];
  return {
    latest,
    previousAverage: averageOf(previous),
    periodAverage: averageOf(sends),
    sends,
    clicksByKind: linkRows,
    topListings,
    detailedCount: sends.filter((s) => s.detailed).length,
  };
}

export type Listing = {
  id: string;
  url: string;
  address: string;
  city: string | null;
  neighborhood: string | null;
  rent: number | null;
  rent_text: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  available: string | null;
  title: string | null;
  description: string | null;
  pets: string | null;
  photo_url: string | null;
  tour_url: string | null;
  flags: string[];
  active: boolean;
  first_seen_at: string;
};

export async function searchListings(filter: { maxRent?: number; minBeds?: number; query?: string; limit?: number; newOnly?: boolean } = {}): Promise<Listing[]> {
  const q = filter.query?.trim();
  return sql<Listing[]>`
    select id, url, address, city, neighborhood, rent, rent_text, beds::float as beds, baths::float as baths, sqft,
           available, title, description, pets, photo_url, tour_url, flags, active, first_seen_at
    from listings
    where active
      ${filter.maxRent ? sql`and rent <= ${filter.maxRent}` : sql``}
      ${filter.minBeds != null ? sql`and beds >= ${filter.minBeds}` : sql``}
      ${filter.newOnly ? sql`and first_seen_at > now() - interval '7 days'` : sql``}
      ${q ? sql`and (address ilike ${'%' + q + '%'} or city ilike ${'%' + q + '%'} or neighborhood ilike ${'%' + q + '%'} or title ilike ${'%' + q + '%'} or description ilike ${'%' + q + '%'})` : sql``}
    order by first_seen_at desc, rent asc nulls last
    limit ${filter.limit ?? 40}`;
}

export async function lastSync() {
  return sql<{ source: string; status: string; detail: string | null; rows: number | null; finished_at: string | null }[]>`
    select distinct on (source) source, status, detail, rows, finished_at
    from sync_runs order by source, started_at desc`;
}
