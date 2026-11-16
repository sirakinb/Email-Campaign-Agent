import { io, type Socket } from 'socket.io-client';
import { json, sql } from '../db.js';
import { env } from '../env.js';
import { addMessage, enqueueJob, resolveThread } from './threads.js';
import { tryDecideFromReply } from './guardrails.js';

/**
 * iMessage through Photon (beta platform). Inbound messages arrive on a
 * Socket.IO stream, so no public address is needed. Only the owner's number
 * is listened to.
 */
const BASE = 'https://api.photon.codes';
const projectId = () => process.env.PHOTON_PROJECT_ID ?? '';

export const textReady = () => Boolean(env.photonKey && projectId() && env.ownerPhone);

type PhotonMessage = {
  id: string;
  platform: string;
  status: string;
  content: { type: string; text?: string; parts?: { type: string; text?: string }[] };
  space: { id: string; kind: string };
  sentBy: { id: string; kind: string; handle?: string };
  receivedBy?: { id: string; kind: string; handle?: string };
};

const digits = (s: string) => s.replace(/\D/g, '').slice(-10);

async function setting<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`select value from settings where key = ${key}`;
  return row?.value ?? null;
}
async function saveSetting(key: string, value: unknown) {
  await sql`insert into settings (key, value) values (${key}, ${json(value)}) on conflict (key) do update set value = excluded.value`;
}

let socket: Socket | null = null;
let state: { connected: boolean; error: string | null } = { connected: false, error: null };
let agentPhone: string | null = null;
export const textState = () => ({ ...state, agentPhone });

async function photonAccessError(): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/v1/projects/${projectId()}`, {
      headers: { Authorization: `Bearer ${env.photonKey}` }, signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      return `Photon rejected the project key (${response.status}). Check the project and grant project:read and project:write.`;
    }
  } catch { /* The Socket.IO error remains the fallback. */ }
  return null;
}

async function loadAssignedNumber() {
  try {
    const response = await fetch(`${BASE}/v1/projects/${projectId()}/platforms/imessage/assignments`, {
      headers: { Authorization: `Bearer ${env.photonKey}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return; // platforms:read is useful for display but not required for messaging.
    const data = await response.json() as { assignments?: { handle: string; assignedPhoneNumber: string }[] };
    agentPhone = data.assignments?.find((a) => digits(a.handle) === digits(env.ownerPhone))?.assignedPhoneNumber ?? null;
  } catch { /* Display information must not prevent receiving messages. */ }
}

export async function startTextChannel() {
  if (!textReady() || socket) return;
  void loadAssignedNumber();
  socket = io(BASE, {
    path: `/v1/projects/${projectId()}/events/ws`,
    addTrailingSlash: false,
    transports: ['websocket'],
    extraHeaders: { Authorization: `Bearer ${env.photonKey}` },
    autoConnect: false,
  });

  socket.on('connect', async () => {
    let startSeq: number | string;
    try { startSeq = (await setting<number | string>('photon_seq')) ?? 0; }
    catch {
      state = { connected: false, error: 'Could not read the saved message cursor. Retrying.' };
      socket!.io.engine.close();
      return;
    }
    socket!.timeout(10_000).emit('subscribe', { startSeq, apiVersion: '2026-07-01' }, (err: unknown, res: any) => {
      if (err || !res?.ok) {
        state = { connected: false, error: res?.error?.code ?? 'Could not subscribe to messages.' };
        socket!.io.engine.close();
        return;
      }
      state = { connected: true, error: null };
    });
  });
  socket.on('disconnect', () => (state = { ...state, connected: false }));
  socket.on('connect_error', async (error: Error) => {
    state = { connected: false, error: error.message };
    const detail = await photonAccessError();
    if (!state.connected && detail) state = { connected: false, error: detail };
  });

  // Handle one message at a time so replies keep their order.
  let chain = Promise.resolve();
  socket.on('delivery', (event: any, meta: { seq?: number | string }) => {
    chain = chain
      .then(() => handleEvent(event))
      .then(() => (meta?.seq !== undefined ? saveSetting('photon_seq', meta.seq) : undefined))
      .catch((error) => console.error('Photon event failed:', (error as Error).message));
  });

  socket.connect();
}

async function handleEvent(event: { id: string; type: string; data?: { object?: PhotonMessage } }) {
  const message = event.data?.object;
  if (event.type !== 'message.received' || !message) return;
  if (message.platform !== 'imessage' || message.space.kind !== 'direct') return;
  if (message.sentBy.kind !== 'human' || !message.receivedBy) return;
  if (digits(message.sentBy.handle ?? '') !== digits(env.ownerPhone)) return;

  const text =
    message.content.type === 'text'
      ? message.content.text
      : message.content.parts?.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  if (!text?.trim()) return;

  const fresh = await sql`
    insert into inbound_seen (channel, external_id) values ('text', ${message.id}) on conflict do nothing returning external_id`;
  if (!fresh.length) return;

  // Remember where to send replies and proactive notes.
  await saveSetting('photon_route', { spaceId: message.space.id, senderId: message.receivedBy.id });

  const { thread, body } = await resolveThread({ channel: 'text', body: text.trim() });
  await addMessage({ threadId: thread.id, role: 'user', channel: 'text', body, meta: { photon_message_id: message.id } });
  if (!(await tryDecideFromReply(thread.id, body, 'text'))) {
    await enqueueJob(thread.id, body, 'text');
  }
}

export async function sendText(text: string, idempotencyKey: string): Promise<boolean> {
  if (!textReady()) return false;
  const route = await setting<{ spaceId: string; senderId: string }>('photon_route');
  // On a shared line the owner has to text first; until then there is nowhere to send.
  if (!route) return false;
  const response = await fetch(`${BASE}/v1/projects/${projectId()}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.photonKey}`,
      'Content-Type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ spaceId: route.spaceId, senderId: route.senderId, content: { type: 'text', format: 'plain', text } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Photon returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return true;
}
