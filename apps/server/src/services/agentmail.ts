import { json, sql } from '../db.js';
import { env } from '../env.js';
import { addMessage, enqueueJob, resolveThread } from './threads.js';
import { tryDecideFromReply } from './guardrails.js';

const BASE = 'https://api.agentmail.to/v0';

export const emailReady = () => Boolean(env.agentmailKey && env.agentmailInbox);

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.agentmailKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AgentMail ${method} ${path.split('?')[0]} returned ${response.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const inboxPath = () => `/inboxes/${encodeURIComponent(env.agentmailInbox)}`;

export async function sendEmail(input: { to: string; subject: string; html: string; text: string; idempotencyKey?: string; labels?: string[] }) {
  return call<{ message_id: string; thread_id: string }>(
    'POST',
    `${inboxPath()}/messages/send`,
    { to: input.to, subject: input.subject, html: input.html, text: input.text, labels: input.labels ?? [] },
    input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey.replace(/[^A-Za-z0-9\-._~]/g, '-').slice(0, 200) } : {},
  );
}

export async function replyEmail(messageId: string, input: { html: string; text: string }) {
  return call<{ message_id: string; thread_id: string }>(
    'POST',
    `${inboxPath()}/messages/${encodeURIComponent(messageId)}/reply`,
    input,
  );
}

type InboundMessage = {
  message_id: string;
  thread_id: string;
  from?: string | string[];
  from_?: string | string[];
  subject?: string;
  text?: string;
  extracted_text?: string;
  preview?: string;
  timestamp: string;
  labels?: string[];
};

const addressOf = (from: string | string[] | undefined): string => {
  const raw = Array.isArray(from) ? (from[0] ?? '') : (from ?? '');
  const match = /<([^>]+)>/.exec(raw);
  return (match ? match[1]! : raw).trim().toLowerCase();
};

/**
 * Reads new mail in the agent's inbox and feeds it into threads. Only mail
 * from the owner's address is acted on; anything else is ignored, because an
 * inbox anyone can write to must not be able to instruct the agent.
 */
export async function pollInbox(): Promise<number> {
  if (!emailReady()) return 0;
  const [cursor] = await sql<{ value: string }[]>`select value from settings where key = 'agentmail_cursor'`;
  const after = (cursor?.value as unknown as string) || new Date(Date.now() - 5 * 60_000).toISOString();
  const page = await call<{ messages: InboundMessage[] }>(
    'GET',
    `${inboxPath()}/messages?labels=received&ascending=true&limit=50&after=${encodeURIComponent(after)}`,
  );
  let handled = 0;
  let latest = after;
  for (const item of page.messages ?? []) {
    if (item.timestamp > latest) latest = item.timestamp;
    const fresh = await sql`
      insert into inbound_seen (channel, external_id) values ('email', ${item.message_id})
      on conflict do nothing returning external_id`;
    if (!fresh.length) continue;
    const sender = addressOf(item.from ?? item.from_);
    if (!env.ownerEmail || sender !== env.ownerEmail.toLowerCase()) continue;

    // List results can omit the body; fetch the full message.
    const full = await call<InboundMessage>('GET', `${inboxPath()}/messages/${encodeURIComponent(item.message_id)}`);
    const text = (full.extracted_text || full.text || full.preview || '').trim();
    if (!text) continue;

    const { thread, body } = await resolveThread({ channel: 'email', body: text, externalId: item.thread_id, subject: full.subject });
    await addMessage({
      threadId: thread.id,
      role: 'user',
      channel: 'email',
      body,
      meta: { email_message_id: item.message_id, email_thread_id: item.thread_id, subject: full.subject ?? null },
    });
    if (!(await tryDecideFromReply(thread.id, body, 'email'))) {
      await enqueueJob(thread.id, body, 'email');
    }
    handled += 1;
  }
  if (latest !== after) {
    await sql`
      insert into settings (key, value) values ('agentmail_cursor', ${json(latest)})
      on conflict (key) do update set value = excluded.value`;
  }
  return handled;
}

/** Sends an agent reply to the email conversation the thread is attached to, if there is one. */
export async function deliverEmailReply(threadId: string, html: string, text: string, threadTitle: string): Promise<boolean> {
  if (!emailReady() || !env.ownerEmail) return false;
  const [last] = await sql<{ meta: { email_message_id?: string } }[]>`
    select meta from messages
    where thread_id = ${threadId} and channel = 'email' and role = 'user' and meta ? 'email_message_id'
    order by created_at desc limit 1`;
  if (last?.meta.email_message_id) {
    await replyEmail(last.meta.email_message_id, { html, text });
    return true;
  }
  const sent = await sendEmail({ to: env.ownerEmail, subject: threadTitle, html, text });
  await sql`
    insert into channel_links (channel, external_id, thread_id) values ('email', ${sent.thread_id}, ${threadId})
    on conflict (channel, external_id) do nothing`;
  return true;
}

export async function checkEmail(): Promise<{ ok: boolean; detail: string }> {
  if (!env.agentmailKey) return { ok: false, detail: 'No AgentMail key.' };
  if (!env.agentmailInbox) return { ok: false, detail: 'No inbox chosen. Set AGENTMAIL_INBOX.' };
  try {
    await call('GET', inboxPath());
    return { ok: true, detail: env.agentmailInbox };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
