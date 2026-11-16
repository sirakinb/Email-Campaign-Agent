import { sql } from '../db.js';
import { env } from '../env.js';
import { gate } from './guardrails.js';
import { analytics, averageOf, getSend, linkGroups, mainSends, searchListings } from './data.js';
import { getDefaults } from './actions.js';
import { hardBounces, isConnected } from './zoho.js';
import { renameThread, setThreadStatus } from './threads.js';
import { publish } from '../bus.js';
import { executeAppTool, isDirectAppRead, listConnectedApps, searchAppTools, validateAppCall } from './connectedApps.js';

/**
 * What the agent can do, as seen from the switchboard. The agent's computer
 * calls these by name; everything that changes the outside world passes
 * through the guardrail gate before it runs.
 */
type Ctx = { threadId: string; jobId: string | null };
type Tool = (input: Record<string, any>, ctx: Ctx) => Promise<unknown>;

const compactSend = (s: Awaited<ReturnType<typeof mainSends>>[number]) => ({
  campaign_id: s.id,
  name: s.name,
  date: s.send_date,
  series: s.series,
  email_number: s.email_number,
  theme: s.theme,
  subject: s.subject,
  sent: s.sent,
  open_rate_pct: s.open_rate,
  reliable_open_rate_pct: s.reliable_open_rate,
  click_rate_pct: s.click_rate,
  clicks: s.clicks,
  unsubscribes: s.optout,
  hard_bounces: s.hard_bounced,
});

const compactListing = (l: Awaited<ReturnType<typeof searchListings>>[number]) => ({
  listing_id: l.id,
  address: l.address,
  area: [l.neighborhood, l.city].filter(Boolean).join(', ') || null,
  rent: l.rent_text ?? l.rent,
  beds: l.beds,
  baths: l.baths,
  sqft: l.sqft,
  available: l.available,
  pets: l.pets,
  has_photo: Boolean(l.photo_url),
  has_virtual_tour: Boolean(l.tour_url),
  new_this_week: Date.now() - new Date(l.first_seen_at).getTime() < 7 * 86_400_000,
  flags: l.flags,
  description: l.description?.slice(0, 280) ?? null,
  url: l.url,
});

export const tools: Record<string, Tool> = {
  connected_apps: async () => ({ apps: await listConnectedApps() }),
  connected_app_search: async ({ app, query }) => searchAppTools(String(app), String(query)),
  connected_app_call: async ({ app, tool, arguments: args, summary }, ctx) => {
    validateAppCall(app, tool, args);
    if (isDirectAppRead(app, tool)) return executeAppTool(app, tool, args);
    // The executor rechecks the connection at approval time, so disconnecting
    // an app also prevents an older pending approval from using it.
    return gate({
      action: 'connected_app_action', threadId: ctx.threadId,
      title: `${app}: ${tool.toLowerCase().replaceAll('_', ' ')}`,
      summary: String(summary || 'Run this action in your connected app.'),
      payload: { app, tool, arguments: args },
    });
  },
  recent_sends: async ({ limit }) => {
    const sends = await mainSends(Math.min(Number(limit) || 8, 40));
    return {
      note: 'Rates are unique opens or clicks over emails sent. open_rate includes Apple Mail automatic opens; reliable_open_rate does not.',
      sends: sends.map(compactSend),
    };
  },

  send_report: async ({ campaign_id }) => {
    const send = await getSend(String(campaign_id));
    if (!send) return { error: 'No campaign with that id in the synced data.' };
    const all = await mainSends(40);
    const index = all.findIndex((s) => s.id === send.id);
    const previous = (index >= 0 ? all.slice(index + 1, index + 7) : all.slice(0, 6));
    return {
      send: compactSend(send),
      clicks_by_destination: (await linkGroups(send.id)).map((g) => ({ label: g.label, kind: g.kind, clicks: g.clicks, listing_id: g.listing_id })),
      average_of_previous_six: averageOf(previous),
    };
  },

  performance_summary: async () => {
    const data = await analytics(12);
    const ranked = [...data.sends].filter((s) => s.click_rate != null).sort((a, b) => (b.click_rate ?? 0) - (a.click_rate ?? 0));
    return {
      last_12_sends_average: data.periodAverage,
      latest: data.latest ? compactSend(data.latest) : null,
      best_by_clicks: ranked.slice(0, 3).map(compactSend),
      weakest_by_clicks: ranked.slice(-3).map(compactSend),
      clicks_by_kind: data.clicksByKind,
      most_clicked_listings: data.topListings,
    };
  },

  search_listings: async ({ max_rent, min_beds, query, new_only, limit }) => {
    const listings = await searchListings({
      maxRent: max_rent ? Number(max_rent) : undefined,
      minBeds: min_beds != null ? Number(min_beds) : undefined,
      query,
      newOnly: Boolean(new_only),
      limit: Math.min(Number(limit) || 20, 60),
    });
    const [total] = await sql<{ count: number }[]>`select count(*)::int as count from listings where active`;
    return { total_active_listings: total?.count ?? 0, listings: listings.map(compactListing) };
  },

  list_drafts: async (_input, ctx) => {
    const drafts = await sql`
      select id as draft_id, name, subject, subject_b, send_on, status, zoho_campaign_id, updated_at, (thread_id = ${ctx.threadId}) as in_this_thread
      from drafts order by updated_at desc limit 20`;
    return { drafts };
  },

  save_draft: async (input, ctx) => {
    for (const field of ['name', 'subject'] as const) {
      if (!input[field]) return { error: `"${field}" is required.` };
    }
    if (!input.html && !(input.headline && input.intro)) {
      return { error: 'Give either "html", or "headline" and "intro" with listing ids so the email can be laid out for you.' };
    }
    return gate({
      action: 'write_draft',
      threadId: ctx.threadId,
      title: `Save draft: ${input.subject}`,
      summary: `Write the email "${input.name}" here in the command center.`,
      payload: input,
    });
  },

  send_test: async ({ draft_id }, ctx) => {
    const [draft] = await sql<{ subject: string }[]>`select subject from drafts where id = ${draft_id}`;
    if (!draft) return { error: 'No draft with that id.' };
    return gate({
      action: 'send_test',
      threadId: ctx.threadId,
      title: `${env.demoMode ? 'Simulate a test' : 'Send a test'} of "${draft.subject}"`,
      summary: env.demoMode ? 'Simulation only. No email will be delivered.' : 'Send this draft from the agent\'s address to your inbox.',
      payload: { draft_id },
    });
  },

  upload_draft: async ({ draft_id }, ctx) => {
    const [draft] = await sql<{ name: string; subject: string; zoho_campaign_id: string | null }[]>`
      select name, subject, zoho_campaign_id from drafts where id = ${draft_id}`;
    if (!draft) return { error: 'No draft with that id.' };
    if (!(await isConnected('zoho_campaigns'))) {
      return { error: 'Zoho Campaigns is not connected yet, so drafts cannot be uploaded. Ask the owner to connect it in Settings.' };
    }
    const defaults = await getDefaults();
    return gate({
      action: 'upload_draft',
      threadId: ctx.threadId,
      title: env.demoMode ? `Simulate Zoho upload: "${draft.name}"` : draft.zoho_campaign_id ? `Update the Zoho draft "${draft.name}"` : `Upload "${draft.name}" to Zoho Campaigns as a draft`,
      summary: `${env.demoMode ? 'SIMULATION ONLY. No external account will be changed. ' : ''}Subject: ${draft.subject}. List: ${defaults.list_name}. Topic: ${defaults.topic_name}. Sender: ${defaults.sender_email}. It is saved as a draft and not scheduled.`,
      payload: { draft_id },
    });
  },

  find_hard_bounces: async ({ campaign_id }) => {
    if (!(await isConnected('zoho_campaigns'))) {
      return { error: 'Zoho Campaigns is not connected yet. Ask the owner to connect it in Settings.' };
    }
    const bounced = await hardBounces(String(campaign_id));
    const reasons: Record<string, number> = {};
    for (const b of bounced) reasons[b.reason ?? 'No reason given'] = (reasons[b.reason ?? 'No reason given'] ?? 0) + 1;
    // Addresses stay on the switchboard; the agent works with counts.
    return { campaign_id, hard_bounces: bounced.length, reasons };
  },

  remove_hard_bounces: async ({ campaign_id }, ctx) => {
    if (!(await isConnected('zoho_campaigns'))) {
      return { error: 'Zoho Campaigns is not connected yet. Ask the owner to connect it in Settings.' };
    }
    const bounced = await hardBounces(String(campaign_id));
    if (!bounced.length) return { status: 'done', result: { removed: 0, note: 'No hard bounces on that send.' } };
    const defaults = await getDefaults();
    const send = await getSend(String(campaign_id));
    return gate({
      action: 'list_hygiene',
      threadId: ctx.threadId,
      title: `Remove ${bounced.length} hard bounces from the ${defaults.list_name} list`,
      summary: `Addresses that hard-bounced on "${send?.name ?? campaign_id}". Removed from the Zoho Campaigns list only; Zoho CRM is not changed.`,
      payload: { list_id: defaults.list_id, list_name: defaults.list_name, contact_ids: bounced.map((b) => b.contactId), campaign_id },
    });
  },

  remember: async ({ title, body }, ctx) => {
    if (!title || !body) return { error: '"title" and "body" are required.' };
    return gate({
      action: 'save_memory',
      threadId: ctx.threadId,
      title: `Remember: ${title}`,
      summary: String(body).slice(0, 600),
      payload: { title, body },
    });
  },

  generate_image: async ({ prompt, aspect }, ctx) => {
    if (!prompt) return { error: '"prompt" is required.' };
    return gate({
      action: 'generate_media',
      threadId: ctx.threadId,
      title: 'Create an image',
      summary: String(prompt).slice(0, 600),
      payload: { prompt, aspect },
    });
  },

  rename_thread: async ({ title, series }, ctx) => {
    if (title) await renameThread(ctx.threadId, String(title));
    if (series !== undefined) {
      await sql`update threads set series = ${series || null} where id = ${ctx.threadId}`;
      publish({ type: 'threads' });
    }
    return { ok: true };
  },

  settle_thread: async (_input, ctx) => {
    await setThreadStatus(ctx.threadId, 'settled');
    return { ok: true, note: 'The thread is settled. It stays in the list, greyed out.' };
  },
};
