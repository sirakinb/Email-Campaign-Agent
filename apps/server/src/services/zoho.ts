import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { json, sql } from '../db.js';
import { env } from '../env.js';

/**
 * Zoho is reached through the account's Zoho MCP servers, signed in once from
 * Settings. This is the only place that talks to Zoho; Zoho stays the system
 * of record. Live sending has a separate, opt-in approval path.
 */
export type ZohoServer = 'zoho_campaigns' | 'zoho_crm';

export class NotConnectedError extends Error {
  constructor(public server: ZohoServer) {
    super(`${server === 'zoho_crm' ? 'Zoho CRM' : 'Zoho Campaigns'} is not connected. Connect it in Settings.`);
  }
}

const serverUrl = (server: ZohoServer) => (server === 'zoho_crm' ? env.zohoCrmMcpUrl : env.zohoCampaignsMcpUrl);

type Secrets = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
};

async function readSecrets(server: ZohoServer): Promise<Secrets> {
  const [row] = await sql<{ secrets: Secrets }[]>`select secrets from connections where id = ${server}`;
  return row?.secrets ?? {};
}

async function patchSecrets(server: ZohoServer, patch: Secrets) {
  await sql`update connections set secrets = secrets || ${json(patch)} where id = ${server}`;
}

function provider(server: ZohoServer, onRedirect?: (url: URL) => void): OAuthClientProvider {
  return {
    get redirectUrl() {
      return `${env.publicUrl}/oauth/callback`;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'Email agent command center',
        redirect_uris: [`${env.publicUrl}/oauth/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: async () => {
      const state = `${server}.${crypto.randomUUID()}`;
      await patchSecrets(server, { state });
      return state;
    },
    clientInformation: async () => (await readSecrets(server)).client,
    saveClientInformation: (client) => patchSecrets(server, { client }),
    tokens: async () => (await readSecrets(server)).tokens,
    saveTokens: async (tokens) => {
      await patchSecrets(server, { tokens });
      await sql`update connections set status = 'connected', checked_at = now() where id = ${server}`;
    },
    redirectToAuthorization: (url) => {
      if (!onRedirect) throw new NotConnectedError(server);
      onRedirect(url);
    },
    saveCodeVerifier: (verifier) => patchSecrets(server, { verifier }),
    codeVerifier: async () => (await readSecrets(server)).verifier ?? '',
  };
}

/** Starts sign-in. Returns the Zoho page to send the browser to, or null if already signed in. */
export async function beginConnect(server: ZohoServer): Promise<string | null> {
  if (!serverUrl(server)) throw new Error(`No MCP address configured for ${server}.`);
  let redirect: URL | null = null;
  const result = await auth(provider(server, (url) => (redirect = url)), { serverUrl: serverUrl(server) });
  if (result === 'AUTHORIZED') return null;
  return redirect ? String(redirect) : null;
}

/** Finishes sign-in after Zoho redirects back with a code. */
export async function finishConnect(state: string, code: string): Promise<ZohoServer> {
  const server = state.split('.')[0] as ZohoServer;
  if (server !== 'zoho_campaigns' && server !== 'zoho_crm') throw new Error('Unknown sign-in state.');
  const saved = await readSecrets(server);
  if (!saved.state || saved.state !== state) throw new Error('Sign-in state did not match. Start again from Settings.');
  const result = await auth(provider(server), { serverUrl: serverUrl(server), authorizationCode: code });
  if (result !== 'AUTHORIZED') throw new Error('Zoho sign-in did not complete.');
  await sql`update connections set secrets = secrets - 'state' - 'verifier' where id = ${server}`;
  clients.delete(server);
  // Validate the MCP session before presenting the connection as successful.
  await (await client(server)).listTools();
  return server;
}

export async function disconnect(server: ZohoServer) {
  clients.delete(server);
  await sql`update connections set secrets = '{}', status = 'not_connected' where id = ${server}`;
}

const clients = new Map<ZohoServer, Promise<Client>>();

async function client(server: ZohoServer): Promise<Client> {
  const existing = clients.get(server);
  if (existing) return existing;
  const created = (async () => {
    if (!serverUrl(server)) throw new NotConnectedError(server);
    if (!(await readSecrets(server)).tokens) throw new NotConnectedError(server);
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl(server)), {
      authProvider: provider(server),
    });
    const c = new Client({ name: 'email-agent-command-center', version: '0.1.0' });
    await c.connect(transport);
    return c;
  })();
  clients.set(server, created);
  created.catch(() => clients.delete(server));
  return created;
}

/**
 * Calls one Zoho tool and returns its `data` payload.
 * Ids must be passed as strings: 18-digit ids lose precision as numbers.
 */
export async function zohoCall<T = unknown>(server: ZohoServer, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  if (env.demoMode) throw new Error('Live Zoho calls are disabled in the demo. Use the fictional local data.');
  let c: Client;
  try {
    c = await client(server);
  } catch (error) {
    if (error instanceof NotConnectedError) throw error;
    await sql`update connections set status = 'error', checked_at = now() where id = ${server}`;
    throw error;
  }
  const result = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.find((part) => part.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`Zoho ${tool} failed: ${text.slice(0, 400)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Zoho ${tool} returned something that is not JSON: ${text.slice(0, 200)}`);
  }
  if (parsed?.status && parsed.status !== 'success') {
    throw new Error(`Zoho ${tool} failed: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  await sql`update connections set status = 'connected', checked_at = now() where id = ${server}`;
  // Responses arrive as { status, headers, data: { data, meta } }.
  return (parsed?.data ?? parsed) as T;
}

export async function isConnected(server: ZohoServer): Promise<boolean> {
  if (env.demoMode) return server === 'zoho_campaigns'; // Local draft simulation only; zohoCall remains blocked.
  return Boolean((await readSecrets(server)).tokens);
}

/** Read-only capability inspection. */
export async function zohoToolCatalog() {
  return (await client('zoho_campaigns')).listTools();
}

export type CampaignForSending = {
  subject: string;
  sender_email: string;
  list_ids: string[];
  topic_id: string;
  revision: unknown;
};

export function campaignForSending(data: any): CampaignForSending {
  if (!data || typeof data !== 'object' || data.status !== 'draft') {
    throw new Error('Only a provider campaign still in draft status can be sent by the agent. Check the campaign in Zoho.');
  }
  const lists = data.recipient?.list_info_array;
  if (typeof data.subject !== 'string' || typeof data.sender_email !== 'string' ||
      typeof data.topic_id !== 'string' || !Array.isArray(lists) || !lists.length ||
      lists.some((list: any) => typeof list.list_id !== 'string')) {
    throw new Error('The provider did not return enough sender and recipient information to verify this live send.');
  }
  if (!data.updated_at && typeof data.content !== 'string') {
    throw new Error('The provider did not return a campaign revision or content for send verification. Send this campaign manually.');
  }
  return { subject: data.subject, sender_email: data.sender_email,
    list_ids: lists.map((list: any) => list.list_id).sort(), topic_id: data.topic_id,
    revision: data };
}

export async function getCampaignForSending(campaignId: string): Promise<CampaignForSending> {
  await liveSendTool();
  return campaignForSending(await getCampaignRevision(campaignId));
}

export async function getCampaignRevision(campaignId: string): Promise<unknown> {
  const response = await zohoCall<{ data: unknown }>('zoho_campaigns', 'ZohoCampaigns_getCampaign', { path_variables: { campaign_id: campaignId } });
  if (!response.data || typeof response.data !== 'object') throw new Error('The provider did not return the uploaded campaign.');
  return response.data;
}

export function validateLiveSendTool(tool: { name: string; inputSchema: any } | undefined) {
  const schema = tool?.inputSchema;
  const path = schema?.properties?.path_variables;
  if (tool?.name !== 'ZohoCampaigns_sendCampaign' || schema?.type !== 'object' ||
      path?.type !== 'object' || path.properties?.campaign_id?.type !== 'string' ||
      (schema.required ?? []).some((key: string) => key !== 'path_variables') ||
      (path.required ?? []).some((key: string) => key !== 'campaign_id')) {
    throw new Error('This Zoho connector does not expose the supported immediate-send tool. Send manually until your connector supports ZohoCampaigns_sendCampaign with a campaign_id path variable.');
  }
}

async function liveSendTool() {
  if (env.demoMode) throw new Error('Live campaign sending is disabled in the demo.');
  const catalog = await zohoToolCatalog();
  const tool = catalog.tools.find((item) => item.name === 'ZohoCampaigns_sendCampaign');
  validateLiveSendTool(tool);
}

/** No retries: callers must durably claim the campaign before invoking this. */
export async function sendCampaignNow(campaignId: string) {
  await liveSendTool();
  return zohoCall('zoho_campaigns', 'ZohoCampaigns_sendCampaign', { path_variables: { campaign_id: campaignId } });
}

// --- The handful of writes the command center is allowed to make -------------

export type DraftUpload = {
  name: string;
  subject: string;
  preheader?: string | null;
  html: string;
  senderEmail: string;
  senderName: string;
  listId: string;
  topicId: string;
};

/** Creates a campaign in Zoho as a draft. It is never scheduled or sent from here. */
export async function createDraftCampaign(draft: DraftUpload): Promise<string> {
  const response = await zohoCall<{ data: { id?: string; campaign_id?: string } }>('zoho_campaigns', 'ZohoCampaigns_createCampaign', {
    body: {
      name: draft.name.slice(0, 150),
      subject: draft.subject.slice(0, 200),
      ...(draft.preheader ? { preheader: draft.preheader.slice(0, 200) } : {}),
      content: draft.html,
      content_type: 'html',
      sender_email: draft.senderEmail,
      sender_name: draft.senderName,
      reply_to: draft.senderEmail,
      list_ids: [draft.listId],
      topic_id: draft.topicId,
    },
  });
  const id = response?.data?.id ?? response?.data?.campaign_id;
  if (!id) throw new Error('Zoho created the campaign but did not return its id.');
  return String(id);
}

export async function updateDraftCampaign(campaignId: string, draft: DraftUpload): Promise<void> {
  await zohoCall('zoho_campaigns', 'ZohoCampaigns_updateCampaign', {
    path_variables: { campaign_id: campaignId },
    body: {
      name: draft.name.slice(0, 150),
      subject: draft.subject.slice(0, 200),
      ...(draft.preheader ? { preheader: draft.preheader.slice(0, 200) } : {}),
      content: draft.html,
      content_type: 'html',
    },
  });
}

/** Removes contacts from a list, 20 at a time (Zoho's limit). Returns how many were sent for removal. */
export async function removeFromList(listId: string, contactIds: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < contactIds.length; i += 20) {
    const batch = contactIds.slice(i, i + 20);
    await zohoCall('zoho_campaigns', 'ZohoCampaigns_dissociateContactsFromLists', {
      body: { ids: [listId], contact_ids: batch },
    });
    removed += batch.length;
  }
  return removed;
}

export type BouncedContact = { contactId: string; email: string; reason: string | null };

/** Hard bounces for one send. The account-wide search is blocked, so this goes send by send. */
export async function hardBounces(campaignId: string, max = 500): Promise<BouncedContact[]> {
  if (env.demoMode) {
    const [report] = await sql<{ hard_bounced: number }[]>`select hard_bounced from zoho_reports where campaign_id = ${campaignId}`;
    return Array.from({ length: Math.min(report?.hard_bounced ?? 0, max) }, (_, i) => ({ contactId: `demo-bounce-${i}`, email: `fictional-${i}@example.com`, reason: 'Fictional invalid mailbox' }));
  }
  const out: BouncedContact[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const page = await zohoCall<{ data: any[]; meta?: { pagination?: { next_cursor?: string; has_more?: boolean } } }>(
      'zoho_campaigns',
      'ZohoCampaigns_getEmailCampaignRecipients',
      {
        path_variables: { campaign_id: campaignId },
        query_params: { activity_type: 'hard_bounce', limit: 100, ...(after ? { after } : {}) },
      },
    );
    for (const row of page.data ?? []) {
      const contactId = row.contact_id ?? row.id ?? row.contact?.id;
      const email = row.email ?? row.contact?.email ?? row.contact_email;
      if (contactId && email) {
        out.push({ contactId: String(contactId), email: String(email), reason: row.matched_activity?.reason ?? row.matched_activity?.bounce_reason ?? null });
      }
    }
    const next = page.meta?.pagination;
    if (!next?.has_more || !next.next_cursor) break;
    after = next.next_cursor;
  }
  return out;
}
