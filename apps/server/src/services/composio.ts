import { Composio } from '@composio/core';
import { json, sql } from '../db.js';
import { env } from '../env.js';

const CLOUDINARY_TOOLS = ['CLOUDINARY_GET_USAGE', 'CLOUDINARY_UPLOAD_ASSET'];
const configured = () => Boolean(process.env.COMPOSIO_API_KEY && env.ownerEmail);
let sdk: Composio | undefined;
export const composio = () => (sdk ??= new Composio());
let pendingSession: ReturnType<Composio['create']> | undefined;

/** One durable session for this single-owner app. The worker accesses it through
 * the switchboard's existing tools; no general execution endpoint is exposed. */
async function session() {
  if (!configured()) throw new Error('Composio needs its project key and the owner email.');
  if (!pendingSession) {
    pendingSession = (async () => {
      const [row] = await sql<{ secrets: { sessionId?: string } }[]>`
        select secrets from connections where id = 'composio_cloudinary'`;
      const id = row?.secrets.sessionId ?? process.env.COMPOSIO_SESSION_ID;
      const policy = {
        toolkits: ['cloudinary'],
        tools: { cloudinary: CLOUDINARY_TOOLS },
        sandbox: { enable: false },
      };
      const s = id ? await composio().sessions.use(id) : await composio().create(env.ownerEmail, policy);
      if (id) await s.update(policy);
      await sql`update connections set secrets = ${json({ sessionId: s.sessionId })} where id = 'composio_cloudinary'`;
      return s;
    })();
    pendingSession.catch(() => { pendingSession = undefined; });
  }
  return pendingSession;
}

type ConnectionState = { status: 'connected' | 'not_connected' | 'error'; detail: string; logId?: string };
let cached: { until: number; value: ConnectionState } | undefined;

export async function cloudinaryConnection(): Promise<ConnectionState> {
  if (!configured()) return { status: 'not_connected', detail: 'Add the Composio project key to enable Cloudinary sign-in.' };
  if (cached && cached.until > Date.now()) return cached.value;
  let value: ConnectionState;
  try {
    const s = await session();
    const list = await s.toolkits();
    const active = list.items.find((t) => t.slug === 'cloudinary')?.connection?.isActive;
    if (!active) {
      value = { status: 'not_connected', detail: 'Connect your Cloudinary account through Composio to host campaign images.' };
    } else {
      const result = await s.execute('CLOUDINARY_GET_USAGE', {});
      if (result.resultType !== 'completed' || !result.logId) {
        value = { status: 'error', detail: 'Cloudinary verification failed. Check the account in Composio and reconnect.', logId: result.logId };
      } else {
        value = { status: 'connected', detail: 'Cloudinary verified through Composio. Campaign image uploads are available.', logId: result.logId };
      }
    }
  } catch {
    value = { status: 'error', detail: 'Could not reach Composio. Check the project key and Cloudinary connection.' };
  }
  cached = { until: Date.now() + (value.status === 'connected' ? 60_000 : 5_000), value };
  await sql`update connections set status = ${value.status}, detail = ${value.detail}, checked_at = now() where id = 'composio_cloudinary'`;
  return value;
}

export async function connectCloudinary(): Promise<string> {
  cached = undefined;
  const connection = await (await session()).authorize('cloudinary', { callbackUrl: `${env.publicUrl}/settings?connected=cloudinary` });
  if (!connection.redirectUrl) throw new Error('Composio did not return a connection link.');
  return connection.redirectUrl;
}

export function uploadedImageUrl(result: { resultType: string; data: Record<string, unknown>; logId: string }): string {
  if (result.resultType !== 'completed') throw new Error(`Cloudinary upload failed (Composio log ${result.logId}).`);
  let payload: any = result.data;
  // Tool results may wrap the provider's JSON in a data field or JSON string.
  for (let depth = 0; depth < 4; depth++) {
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { break; } }
    if (payload?.successful === false) break;
    if (typeof payload?.secure_url === 'string') {
      const url = new URL(payload.secure_url);
      if (url.protocol === 'https:') return url.href;
      break;
    }
    if (!payload?.data) break;
    payload = payload.data;
  }
  throw new Error(`Cloudinary did not return a hosted HTTPS image (Composio log ${result.logId}).`);
}

/** Called only by the existing guarded generate_image action. */
export async function uploadWithComposio(sourceUrl: string, folder: string): Promise<string> {
  const result = await (await session()).execute('CLOUDINARY_UPLOAD_ASSET', {
    file_url: sourceUrl, folder, resource_type: 'image', overwrite: false,
  });
  return uploadedImageUrl(result);
}
