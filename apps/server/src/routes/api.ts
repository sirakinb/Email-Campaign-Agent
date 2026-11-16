import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { json, sql } from '../db.js';
import { env } from '../env.js';
import { publish, subscribe } from '../bus.js';
import {
  addMessage,
  createThread,
  deleteThread,
  enqueueJob,
  getThread,
  listThreads,
  renameThread,
  setThreadStatus,
} from '../services/threads.js';
import { decide } from '../services/guardrails.js';
import { analytics, averageOf, getSend, lastSync, linkGroups, listSends, mainSends, searchListings } from '../services/data.js';
import { beginConnect, disconnect, isConnected, type ZohoServer } from '../services/zoho.js';
import { boxConfigured, computerStatus, handBack, powerOff, powerOn, screenLink } from '../services/instabox.js';
import { emailReady } from '../services/agentmail.js';
import { textReady, textState } from '../services/photon.js';
import { hostingReady, mediaReady } from '../services/media.js';
import { cloudinaryConnection, connectCloudinary } from '../services/composio.js';
import { appCatalog, appsConfigured, connectApp, disconnectApp, listConnectedApps } from '../services/connectedApps.js';
import { nextRun, runAutomation, setAutomationEnabled } from '../services/scheduler.js';
import { runSync, syncRunning } from '../services/sync.js';
import { initializeDemo } from '../demo.js';

export const api = new Hono();

// --- Sign-in -------------------------------------------------------------------
// One owner, one password. With no password set the app is open, which is only
// allowed outside production.

const COOKIE = 'ea_session';
const authRequired = () => Boolean(env.appPassword) || env.isProd;

async function signedIn(c: Parameters<Parameters<typeof api.use>[1]>[0]): Promise<boolean> {
  if (!authRequired()) return true;
  return (await getSignedCookie(c, env.sessionSecret, COOKIE)) === 'owner';
}

api.get('/session', async (c) => c.json({ signedIn: await signedIn(c), authRequired: authRequired() }));

api.post('/login', async (c) => {
  const { password } = await c.req.json<{ password?: string }>();
  const given = Buffer.from(password ?? '');
  const expected = Buffer.from(env.appPassword);
  if (!env.appPassword || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    await new Promise((r) => setTimeout(r, 600));
    return c.json({ error: 'That password is not right.' }, 401);
  }
  await setSignedCookie(c, COOKIE, 'owner', env.sessionSecret, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

api.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

api.use('*', async (c, next) => {
  if (!(await signedIn(c))) return c.json({ error: 'Sign in first.' }, 401);
  if (env.demoMode && /^\/api\/(?:connected-apps|connections|computer\/handback|automations)/.test(c.req.path)) return c.json({ error: 'Live integrations and desktop control are disabled in the demo.' }, 403);
  await next();
});

api.post('/demo/reset', async (c) => {
  if (!env.demoMode) return c.notFound();
  try { await initializeDemo(true); publish({ type: 'threads' }); return c.json({ ok: true }); }
  catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

// --- Live updates --------------------------------------------------------------

api.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const off = subscribe((event) => {
      queue.push(JSON.stringify(event));
      wake?.();
    });
    stream.onAbort(() => {
      off();
      wake?.();
    });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 20_000);
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
      while (queue.length && !stream.aborted) await stream.writeSSE({ data: queue.shift()! });
    }
    off();
  }),
);

// --- Bootstrap -----------------------------------------------------------------

async function settingsMap() {
  const rows = await sql<{ key: string; value: any }[]>`select key, value from settings where key in ('agent', 'brand', 'defaults')`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as { agent: { name: string; enabled: boolean }; brand: any; defaults: any };
}

api.get('/bootstrap', async (c) => {
  const settings = await settingsMap();
  const [counts] = await sql<{ approvals: number }[]>`select count(*)::int as approvals from approvals where status = 'pending'`;
  return c.json({
    ...settings,
    demoMode: env.demoMode,
    computer: await computerStatus(),
    pendingApprovals: counts!.approvals,
    channels: { email: emailReady() ? env.agentmailInbox : null, text: textReady() },
  });
});

// --- Threads -------------------------------------------------------------------

api.get('/threads', async (c) => c.json({ threads: await listThreads() }));

api.post('/threads', async (c) => {
  const { title, message } = await c.req.json<{ title?: string; message?: string }>();
  const thread = await createThread({ title: title || message?.split('\n')[0]?.slice(0, 80), via: 'chat' });
  if (message?.trim()) {
    await addMessage({ threadId: thread.id, role: 'user', channel: 'chat', body: message.trim() });
    await enqueueJob(thread.id, message.trim(), 'chat');
  }
  return c.json({ thread });
});

api.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const thread = await getThread(id);
  if (!thread) return c.json({ error: 'That thread no longer exists.' }, 404);
  const [messages, steps, approvals, drafts, jobs] = await Promise.all([
    sql`select id, role, channel, body, meta, created_at from messages where thread_id = ${id} order by created_at`,
    sql`select id, job_id, label, detail, status, created_at from run_steps where thread_id = ${id} order by created_at`,
    sql`select id, action, title, summary, payload, status, result, decided_via, created_at, decided_at from approvals where thread_id = ${id} order by created_at`,
    sql`select id, name, subject, subject_b, preheader, send_on, status, zoho_campaign_id, listing_ids, created_at, updated_at from drafts where thread_id = ${id} order by created_at`,
    sql`select id, status, created_at, started_at from agent_jobs where thread_id = ${id} and status in ('queued', 'running') order by created_at`,
  ]);
  return c.json({ thread, messages, steps, approvals, drafts, jobs });
});

api.patch('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; status?: 'open' | 'settled' }>();
  if (body.title !== undefined) await renameThread(id, body.title);
  if (body.status === 'open') await setThreadStatus(id, 'open');
  return c.json({ thread: await getThread(id) });
});

api.post('/threads/:id/messages', async (c) => {
  const id = c.req.param('id');
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) return c.json({ error: 'Write a message first.' }, 400);
  const thread = await getThread(id);
  if (!thread) return c.json({ error: 'That thread no longer exists.' }, 404);
  if (thread.status === 'settled') await setThreadStatus(id, 'open');
  const message = await addMessage({ threadId: id, role: 'user', channel: 'chat', body: body.trim() });
  await enqueueJob(id, body.trim(), 'chat');
  return c.json({ message });
});

/**
 * Settling asks the agent to write up what is worth keeping, then marks the
 * thread settled. If the agent is switched off, the thread is settled as is.
 */
api.post('/threads/:id/settle', async (c) => {
  const id = c.req.param('id');
  const settings = await settingsMap();
  if (settings.agent.enabled === false) {
    await setThreadStatus(id, 'settled');
    return c.json({ settled: true });
  }
  await addMessage({ threadId: id, role: 'system', channel: 'chat', body: 'Settling this thread.' });
  await enqueueJob(
    id,
    'The owner is settling this thread. If anything here is worth keeping for future threads (a preference, a decision, a lesson from results), save it with the remember tool: one memory per distinct point, written so it makes sense without this conversation. If nothing is worth keeping, save nothing. Then call settle_thread and reply with one short sentence saying what you kept.',
    'chat',
  );
  return c.json({ settled: false, queued: true });
});

api.post('/threads/:id/stop', async (c) => {
  const id = c.req.param('id');
  await sql`update agent_jobs set status = 'cancelled', finished_at = now() where thread_id = ${id} and status in ('queued', 'running')`;
  publish({ type: 'threads' });
  publish({ type: 'thread', threadId: id });
  return c.json({ ok: true });
});

api.delete('/threads/:id', async (c) => {
  const mode = c.req.query('mode') === 'history' ? 'history' : 'list';
  await deleteThread(c.req.param('id'), mode);
  return c.json({ ok: true });
});

// --- Approvals -----------------------------------------------------------------

api.get('/approvals', async (c) => {
  const approvals = await sql`
    select a.id, a.action, a.title, a.summary, a.payload, a.status, a.created_at, a.thread_id, t.title as thread_title
    from approvals a left join threads t on t.id = a.thread_id
    where a.status = 'pending' order by a.created_at`;
  return c.json({ approvals });
});

api.post('/approvals/:id/decide', async (c) => {
  const { approve } = await c.req.json<{ approve: boolean }>();
  if (typeof approve !== 'boolean') return c.json({ error: 'Choose approve or decline.' }, 400);
  return c.json(await decide(c.req.param('id'), Boolean(approve), 'chat'));
});

// --- Drafts --------------------------------------------------------------------

api.get('/drafts/:id', async (c) => {
  const [draft] = await sql`select * from drafts where id = ${c.req.param('id')}`;
  if (!draft) return c.json({ error: 'That draft no longer exists.' }, 404);
  const ids = (draft.listing_ids as string[]) ?? [];
  const listings = ids.length ? await sql`select id, address, rent_text, rent, beds::float, baths::float, url from listings where id in ${sql(ids)}` : [];
  return c.json({ draft, listings });
});

/** The email itself, for the preview frame. Scripts are blocked by the frame's sandbox and this policy. */
api.get('/drafts/:id/preview', async (c) => {
  const [draft] = await sql<{ html: string }[]>`select html from drafts where id = ${c.req.param('id')}`;
  if (!draft) return c.text('Not found', 404);
  c.header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https:");
  return c.html(draft.html);
});

// --- Today ---------------------------------------------------------------------

api.get('/today', async (c) => {
  const [approvals, drafts, memories, automations, sends, sync, listingStats] = await Promise.all([
    sql`
      select a.id, a.action, a.title, a.summary, a.payload, a.status, a.created_at, a.thread_id, t.title as thread_title
      from approvals a left join threads t on t.id = a.thread_id
      where a.status = 'pending' order by a.created_at`,
    sql`
      select d.id, d.name, d.subject, d.send_on, d.status, d.zoho_campaign_id, d.thread_id, d.updated_at, z.status as zoho_status
      from drafts d left join zoho_campaigns z on z.id = d.zoho_campaign_id
      where d.updated_at > now() - interval '21 days' and coalesce(z.status, 'draft') <> 'sent'
      order by d.send_on nulls last, d.updated_at desc limit 12`,
    sql`select id, title, body, created_at, source_thread_id from memories order by created_at desc limit 4`,
    sql<{ id: string; label: string; description: string; enabled: boolean; last_run_at: string | null; last_status: string | null }[]>`
      select id, label, description, enabled, last_run_at, last_status from automations where enabled order by position`,
    mainSends(8),
    lastSync(),
    sql<{ active: number; fresh: number; flagged: number }[]>`
      select count(*) filter (where active)::int as active,
             count(*) filter (where active and first_seen_at > now() - interval '7 days')::int as fresh,
             count(*) filter (where active and jsonb_array_length(flags) > 0)::int as flagged
      from listings`,
  ]);
  const latest = sends[0] ?? null;
  return c.json({
    approvals,
    drafts,
    memories,
    schedule: automations.map((a) => ({ ...a, next_run_at: nextRun(a.id) })),
    latest,
    previousAverage: averageOf(sends.slice(1, 7)),
    recent: sends.slice(0, 2),
    sync,
    syncRunning: syncRunning(),
    listings: listingStats[0],
  });
});

// --- Campaigns and analytics -----------------------------------------------------

api.get('/campaigns', async (c) => {
  const year = Number(c.req.query('year')) || new Date().getFullYear();
  const [sends, years, drafts] = await Promise.all([
    listSends({ year, limit: 400 }),
    sql<{ year: number }[]>`
      select distinct extract(year from coalesce(send_date, created_at::date))::int as year
      from zoho_campaigns order by 1 desc`,
    sql`
      select d.id, d.name, d.subject, d.subject_b, d.send_on, d.status, d.zoho_campaign_id, d.thread_id, d.updated_at
      from drafts d left join zoho_campaigns z on z.id = d.zoho_campaign_id
      where coalesce(z.status, 'draft') <> 'sent' order by d.send_on nulls last, d.updated_at desc`,
  ]);
  return c.json({ year, years: years.map((y) => y.year), sends, drafts });
});

api.get('/campaigns/:id', async (c) => {
  const send = await getSend(c.req.param('id'));
  if (!send) return c.json({ error: 'That campaign is not in the synced data.' }, 404);
  const all = await mainSends(60);
  const index = all.findIndex((s) => s.id === send.id);
  const previous = index >= 0 ? all.slice(index + 1, index + 7) : all.slice(0, 6);
  const [campaign] = await sql`
    select sender_email, sender_name, list_names, topic_name, preheader, created_at, updated_at from zoho_campaigns where id = ${send.id}`;
  const [draft] = await sql`select id, thread_id from drafts where zoho_campaign_id = ${send.id} limit 1`;
  return c.json({ send, campaign, links: await linkGroups(send.id), previous, previousAverage: averageOf(previous), draft: draft ?? null });
});

api.get('/analytics', async (c) => c.json(await analytics(Math.min(Number(c.req.query('count')) || 12, 40))));

api.get('/listings', async (c) =>
  c.json({ listings: await searchListings({ query: c.req.query('q'), limit: 200 }) }),
);

// --- Settings ------------------------------------------------------------------

api.get('/connected-apps', async (c) => c.json({ configured: appsConfigured(), apps: await listConnectedApps(c.req.query('refresh') === 'true') }));
api.get('/connected-apps/catalog', async (c) => {
  try { return c.json(await appCatalog(c.req.query('q') ?? '', c.req.query('cursor'))); }
  catch (error) { return c.json({ error: (error as Error).message }, 502); }
});
api.post('/connected-apps/:slug/connect', async (c) => {
  try { return c.json({ url: await connectApp(c.req.param('slug')) }); }
  catch (error) { return c.json({ error: (error as Error).message }, 502); }
});
api.post('/connected-apps/:slug/disconnect', async (c) => {
  await disconnectApp(c.req.param('slug'));
  return c.json({ ok: true });
});

async function connectionList() {
  if (env.demoMode) return [
    { id: 'demo_data', label: 'Fictional campaign data', detail: 'Invented properties and results. No client database or live integrations.', status: 'connected', action: null },
    { id: 'demo_upload', label: 'Campaign draft handoff', detail: 'Simulated after approval. Nothing is sent to a real Zoho account.', status: 'not_connected', action: null },
  ];
  const rows = await sql<{ id: string; label: string; detail: string; status: string; checked_at: string | null }[]>`
    select id, label, detail, status, checked_at from connections order by position`;
  const sync = await lastSync();
  const appfolio = sync.find((s) => s.source === 'appfolio');
  return Promise.all(
    rows.map(async (row) => {
      switch (row.id) {
        case 'zoho_campaigns':
        case 'zoho_crm': {
          const connected = await isConnected(row.id as ZohoServer);
          return { ...row, status: connected ? (row.status === 'error' ? 'error' : 'connected') : 'not_connected', action: connected ? 'disconnect' : 'connect' };
        }
        case 'appfolio':
          return {
            ...row,
            status: appfolio ? (appfolio.status === 'ok' ? 'connected' : 'error') : 'not_connected',
            detail: appfolio?.status === 'ok' ? `${appfolio.rows ?? 0} listings read from the public page.` : (appfolio?.detail ?? row.detail),
            checked_at: appfolio?.finished_at ?? null,
            action: null,
          };
        case 'agentmail':
          return {
            ...row,
            status: emailReady() ? 'connected' : 'not_connected',
            detail: emailReady() ? `${env.agentmailInbox}${env.ownerEmail ? `, listening to ${env.ownerEmail}` : ', but no owner address is set'}` : 'No inbox chosen yet.',
            action: null,
          };
        case 'photon': {
          const state = textState();
          return {
            ...row,
            status: !textReady() ? 'not_connected' : state.error ? 'error' : state.connected ? 'connected' : 'not_connected',
            detail: !textReady() ? 'Needs the Photon project ID and your phone number.' : state.error ? state.error : state.agentPhone ? `Text ${state.agentPhone} from your phone ending ${env.ownerPhone.slice(-4)}.` : `iMessage through Photon, listening to your phone ending ${env.ownerPhone.slice(-4)}.`,
            action: null,
          };
        }
        case 'instabox': {
          const status = await computerStatus();
          return {
            ...row,
            status: !boxConfigured() ? 'not_connected' : status.state === 'error' ? 'error' : 'connected',
            detail: !boxConfigured() ? 'No machine chosen yet.' : `${status.name ?? 'InstaBox machine'}${status.size ? `, ${status.size}` : ''}`,
            action: null,
          };
        }
        case 'composio_cloudinary': {
          const connection = await cloudinaryConnection();
          return { ...row, ...connection, action: connection.status === 'connected' ? null : 'connect' };
        }
        case 'media': {
          const hosted = await hostingReady();
          return {
            ...row,
            status: mediaReady() && hosted ? 'connected' : mediaReady() ? 'error' : 'not_connected',
            detail: mediaReady() && hosted ? row.detail : mediaReady() ? 'FAL is configured. Connect Cloudinary below to host generated images.' : row.detail,
            action: null,
          };
        }
        default:
          return { ...row, action: null };
      }
    }),
  );
}

api.get('/settings', async (c) => {
  const [guardrails, automations, memories] = await Promise.all([
    sql`select action, label, description, level, locked from guardrails order by position`,
    sql<{ id: string }[]>`select id, label, description, cron, kind, enabled, last_run_at, last_status from automations order by position`,
    sql`select id, title, body, created_at from memories order by created_at desc`,
  ]);
  return c.json({
    ...(await settingsMap()),
    guardrails,
    automations: automations.map((a) => ({ ...a, next_run_at: nextRun(a.id) })),
    connections: await connectionList(),
    computer: await computerStatus(),
    memories,
    sync: await lastSync(),
    syncRunning: syncRunning(),
  });
});

api.patch('/guardrails/:action', async (c) => {
  const { level } = await c.req.json<{ level: string }>();
  if (!['draft_only', 'approve_first', 'autonomous'].includes(level)) return c.json({ error: 'Unknown level.' }, 400);
  const updated = await sql`update guardrails set level = ${level} where action = ${c.req.param('action')} and not locked returning action`;
  if (!updated.length) return c.json({ error: 'That guardrail cannot be changed.' }, 400);
  return c.json({ ok: true });
});

api.patch('/automations/:id', async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  if (typeof enabled !== 'boolean') return c.json({ error: 'Enabled must be true or false.' }, 400);
  await sql`update automations set enabled = ${Boolean(enabled)} where id = ${c.req.param('id')}`;
  setAutomationEnabled(c.req.param('id'), Boolean(enabled));
  return c.json({ ok: true });
});

api.post('/automations/:id/run', async (c) => {
  const id = c.req.param('id');
  if (id === 'sync') {
    void runAutomation(id);
    return c.json({ started: true });
  }
  return c.json(await runAutomation(id));
});

api.patch('/settings/:key', async (c) => {
  const key = c.req.param('key');
  if (!['agent', 'brand', 'defaults'].includes(key)) return c.json({ error: 'Unknown setting.' }, 400);
  const patch = await c.req.json<Record<string, unknown>>();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return c.json({ error: 'Expected settings.' }, 400);
  const fields: Record<string, string[]> = {
    agent: ['name'],
    brand: ['name', 'product', 'accent'],
    defaults: ['sender_email', 'sender_name', 'list_id', 'list_name', 'topic_id', 'topic_name', 'listings_url'],
  };
  for (const [field, value] of Object.entries(patch)) {
    if (!fields[key]!.includes(field) || typeof value !== 'string' || (key !== 'defaults' && !value.trim()) || value.length > 500) {
      return c.json({ error: 'Invalid setting value.' }, 400);
    }
    if (field === 'accent' && !/^#[a-f0-9]{6}$/i.test(value)) return c.json({ error: 'Choose a six-digit hex colour.' }, 400);
  }
  await sql`update settings set value = value || ${json(patch)} where key = ${key}`;
  if (key === 'agent') publish({ type: 'computer' });
  return c.json(await settingsMap());
});

api.delete('/memories/:id', async (c) => {
  await sql`delete from memories where id = ${c.req.param('id')}`;
  return c.json({ ok: true });
});

api.post('/connections/:id/connect', async (c) => {
  const id = c.req.param('id');
  if (id === 'composio_cloudinary') {
    try { return c.json({ url: await connectCloudinary() }); }
    catch { return c.json({ error: 'Could not start the Cloudinary connection. Check the Composio project key.' }, 502); }
  }
  if (id !== 'zoho_campaigns' && id !== 'zoho_crm') return c.json({ error: 'This connection is set up with keys, not sign-in.' }, 400);
  try {
    return c.json({ url: await beginConnect(id) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

api.post('/connections/:id/disconnect', async (c) => {
  const id = c.req.param('id');
  if (id !== 'zoho_campaigns' && id !== 'zoho_crm') return c.json({ error: 'This connection cannot be disconnected here.' }, 400);
  await disconnect(id);
  return c.json({ ok: true });
});

api.post('/sync', (c) => {
  void runSync();
  return c.json({ started: true });
});

// --- The agent's computer --------------------------------------------------------

api.get('/computer', async (c) => c.json(await computerStatus()));

api.post('/computer/power', async (c) => {
  const { on } = await c.req.json<{ on: boolean }>();
  if (typeof on !== 'boolean') return c.json({ error: 'Power must be true or false.' }, 400);
  // Switching off also stops new work being handed out; messages wait in their threads.
  await sql`update settings set value = value || ${json({ enabled: Boolean(on) })} where key = 'agent'`;
  try {
    if (boxConfigured()) await (on ? powerOn() : powerOff());
  } catch (error) {
    return c.json({ error: (error as Error).message, computer: await computerStatus() }, 502);
  }
  publish({ type: 'computer' });
  return c.json({ computer: await computerStatus() });
});

api.post('/computer/screen', async (c) => {
  const { control } = await c.req.json<{ control?: boolean }>();
  if (env.demoMode && control) return c.json({ error: 'The demo desktop is read-only.' }, 403);
  if (!boxConfigured()) return c.json({ error: 'No machine is connected yet.' }, 400);
  try {
    return c.json(await screenLink(Boolean(control)));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

api.post('/computer/handback', async (c) => {
  try {
    await handBack();
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});
