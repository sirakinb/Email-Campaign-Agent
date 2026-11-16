import { sql } from '../db.js';
import { env } from '../env.js';
import { composio } from './composio.js';

type AppRow = { slug: string; name: string; logo: string | null; session_id: string | null; enabled: boolean };
const sessions = new Map<string, ReturnType<ReturnType<typeof composio>['create']>>();
const requests = () => ({ signal: AbortSignal.timeout(30_000) });
export const appsConfigured = () => !env.demoMode && Boolean(process.env.COMPOSIO_API_KEY && env.ownerEmail);

export function supportedApp(slug: string) {
  // These integrations have dedicated paths and campaign guardrails already.
  return /^[a-z][a-z0-9_]{0,79}$/.test(slug) && !/^(zoho|composio|custom_)/.test(slug) && slug !== 'cloudinary';
}

export function validateAppCall(slug: string, tool: string, input: unknown) {
  if (!supportedApp(slug)) throw new Error('Use the existing connection for this app.');
  if (!/^[A-Z][A-Z0-9_]{1,159}$/.test(tool) || tool.startsWith('COMPOSIO_')) throw new Error('Choose an app tool returned by connected_app_search.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 32_000) throw new Error('App arguments must be an object under 32,000 characters.');
}

export const isDirectAppRead = (slug: string, tool: string) => slug === 'gmail' && [
  'GMAIL_GET_PROFILE', 'GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
].includes(tool);

export async function appCatalog(query: string, cursor?: string) {
  if (!appsConfigured()) throw new Error('Composio is not configured.');
  const params = new URLSearchParams({ limit: '24', ...(query ? { search: query.slice(0,100) } : {}), ...(cursor ? { cursor } : {}) });
  const response = await fetch(`https://backend.composio.dev/api/v3.1/toolkits?${params}`, {
    headers: { 'x-api-key': process.env.COMPOSIO_API_KEY! }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not load the app catalog (${response.status}).`);
  const data = await response.json() as { items: { slug: string; name: string; no_auth: boolean; meta?: { logo?: string; description?: string } }[]; next_cursor?: string };
  return {
    apps: data.items.filter((t) => supportedApp(t.slug) && !t.no_auth).map((t) => ({ slug: t.slug, name: t.name, logo: t.meta?.logo, description: t.meta?.description })),
    nextCursor: data.next_cursor ?? null,
  };
}

async function rowFor(slug: string) {
  const [row] = await sql<AppRow[]>`select * from connected_apps where slug = ${slug} and enabled`;
  if (!row) throw new Error('Connect this app in Settings first.');
  return row;
}

async function appSession(slug: string) {
  if (env.demoMode) throw new Error('Live app access is disabled in this demo.');
  const row = await rowFor(slug); // Recheck even when a session is cached: disconnect takes effect immediately.
  if (!sessions.has(slug)) {
    const pending = (async () => {
      const s = row.session_id
        ? await composio().sessions.use(row.session_id, undefined, requests())
        : await composio().create(env.ownerEmail, { toolkits: [slug], sandbox: { enable: false }, manageConnections: { enable: false } }, requests());
      await sql`update connected_apps set session_id = ${s.sessionId} where slug = ${slug}`;
      return s;
    })();
    sessions.set(slug, pending);
    pending.catch(() => sessions.delete(slug));
  }
  return sessions.get(slug)!;
}

const statusCache = new Map<string, { until: number; status: string; detail: string }>();
async function appStatus(row: AppRow, fresh = false) {
  const cached = statusCache.get(row.slug);
  if (!fresh && cached && cached.until > Date.now()) return cached;
  let status = 'not_connected', detail = 'Finish connecting this app.';
  try {
    const s = await appSession(row.slug);
    const state = (await s.toolkits({ toolkits: [row.slug] })).items[0];
    if (state?.connection?.isActive) {
      status = 'connected'; detail = 'Connected through Composio. App actions follow your guardrails.';
      if (row.slug === 'gmail') {
        const profile = await s.execute('GMAIL_GET_PROFILE', { user_id: 'me' });
        if (profile.resultType !== 'completed') throw new Error('Gmail verification failed.');
        const data = (profile.data.data ?? profile.data) as Record<string, unknown>;
        detail = typeof data.emailAddress === 'string' ? `${data.emailAddress} · Inbox search and reading are available.` : 'Gmail verified. Inbox search and reading are available.';
      }
    }
  } catch { status = 'error'; detail = 'Could not verify this connection. Try reconnecting.'; }
  const result = { until: Date.now() + 15_000, status, detail };
  statusCache.set(row.slug, result);
  return result;
}

export async function listConnectedApps(fresh = false) {
  if (env.demoMode) return [];
  const rows = await sql<AppRow[]>`select * from connected_apps where enabled order by name`;
  return Promise.all(rows.map(async (row) => {
    const state = await appStatus(row, fresh);
    return { slug: row.slug, name: row.name, logo: row.logo, status: state.status, detail: state.detail };
  }));
}

export async function connectApp(slug: string) {
  if (!appsConfigured() || !supportedApp(slug)) throw new Error('This app cannot be connected here.');
  const toolkit = await composio().toolkits.get(slug, requests());
  await sql`insert into connected_apps (slug, name, logo) values (${slug}, ${toolkit.name}, ${toolkit.meta.logo ?? null})
    on conflict (slug) do update set enabled = true, name = excluded.name, logo = excluded.logo`;
  statusCache.delete(slug);
  const s = await appSession(slug);
  // authorize is the explicit Settings flow, independent of agent connection prompts.
  const link = await s.authorize(slug, { callbackUrl: `${env.publicUrl}/settings?connected_app=${encodeURIComponent(slug)}` });
  if (!link.redirectUrl) throw new Error('Composio did not return a connection link.');
  return link.redirectUrl;
}

export async function disconnectApp(slug: string) {
  await rowFor(slug);
  // Remove Penny's access locally. Other agents sharing this Composio account keep their connections.
  await sql`update connected_apps set enabled = false where slug = ${slug}`;
  sessions.delete(slug); statusCache.delete(slug);
}

export async function searchAppTools(slug: string, query: string) {
  if (!supportedApp(slug)) throw new Error('Use the existing connection for this app.');
  const result = await (await appSession(slug)).search({ query: query.slice(0,1000), toolkits: [slug] });
  return { ...result, note: 'Only the three Gmail profile/search/message-read tools run directly. Other app calls follow the Connected app actions guardrail.' };
}

export async function executeAppTool(slug: string, tool: string, input: Record<string, unknown>) {
  validateAppCall(slug, tool, input);
  const result = await (await appSession(slug)).execute(tool, input);
  if (result.resultType !== 'completed') throw new Error(`App action failed: ${result.error ?? result.resultType} (Composio log ${result.logId}).`);
  return { data: result.data, logId: result.logId };
}
