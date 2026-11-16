import { json, sql } from '../db.js';
import { publish } from '../bus.js';
import { wakeForWork } from './instabox.js';
import { newThreadBody } from './threadCommand.js';

export type Channel = 'chat' | 'text' | 'email' | 'automation';

export type Thread = {
  id: string;
  title: string;
  status: 'open' | 'settled';
  hidden: boolean;
  series: string | null;
  sdk_session_id: string | null;
  created_via: Channel;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  last_message_at: string;
};

export type Message = {
  id: string;
  thread_id: string;
  role: 'user' | 'agent' | 'system';
  channel: Channel;
  body: string;
  meta: Record<string, unknown>;
  created_at: string;
};

export async function createThread(input: { title?: string; via?: Channel; series?: string | null }): Promise<Thread> {
  const [thread] = await sql<Thread[]>`
    insert into threads (title, created_via, series)
    values (${input.title?.trim() || 'New thread'}, ${input.via ?? 'chat'}, ${input.series ?? null})
    returning *`;
  publish({ type: 'threads' });
  return thread!;
}

export async function getThread(id: string): Promise<Thread | null> {
  const [thread] = await sql<Thread[]>`select * from threads where id = ${id}`;
  return thread ?? null;
}

export async function listThreads() {
  return sql<(Thread & { working: boolean; pending_approvals: number; preview: string | null; last_channel: Channel | null })[]>`
    select t.*,
      exists (select 1 from agent_jobs j where j.thread_id = t.id and j.status in ('queued', 'running')) as working,
      (select count(*)::int from approvals a where a.thread_id = t.id and a.status = 'pending') as pending_approvals,
      (select left(m.body, 140) from messages m where m.thread_id = t.id and m.role <> 'system' order by m.created_at desc limit 1) as preview,
      (select m.channel from messages m where m.thread_id = t.id and m.role = 'user' order by m.created_at desc limit 1) as last_channel
    from threads t
    where not t.hidden
    order by (t.status = 'settled'), t.last_message_at desc`;
}

export async function addMessage(input: {
  threadId: string;
  role: Message['role'];
  channel: Channel;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<Message> {
  const [message] = await sql<Message[]>`
    insert into messages (thread_id, role, channel, body, meta)
    values (${input.threadId}, ${input.role}, ${input.channel}, ${input.body}, ${json(input.meta ?? {})})
    returning *`;
  await sql`update threads set last_message_at = now(), updated_at = now() where id = ${input.threadId}`;
  publish({ type: 'message', threadId: input.threadId, messageId: message!.id });
  publish({ type: 'threads' });
  return message!;
}

export async function enqueueJob(threadId: string, prompt: string, channel: Channel) {
  const [job] = await sql<{ id: string }[]>`
    insert into agent_jobs (thread_id, prompt, channel) values (${threadId}, ${prompt}, ${channel}) returning id`;
  publish({ type: 'job', threadId, jobId: job!.id, status: 'queued' });
  publish({ type: 'threads' });
  void wakeForWork();
  return job!.id;
}

export async function renameThread(id: string, title: string) {
  await sql`update threads set title = ${title.trim().slice(0, 120) || 'Untitled'}, updated_at = now() where id = ${id}`;
  publish({ type: 'thread', threadId: id });
  publish({ type: 'threads' });
}

export async function setThreadStatus(id: string, status: 'open' | 'settled') {
  await sql`
    update threads
    set status = ${status}, settled_at = ${status === 'settled' ? sql`now()` : null}, updated_at = now()
    where id = ${id}`;
  publish({ type: 'thread', threadId: id });
  publish({ type: 'threads' });
}

/**
 * Two kinds of delete. "list" takes the thread off the screen and keeps its
 * history. "history" removes the thread and everything said in it for good.
 * Neither touches what was already saved to memory.
 */
export async function deleteThread(id: string, mode: 'list' | 'history') {
  if (mode === 'history') {
    await sql`delete from threads where id = ${id}`;
  } else {
    await sql`update threads set hidden = true, updated_at = now() where id = ${id}`;
  }
  publish({ type: 'threads' });
}


/**
 * Finds the thread a message from outside the command center belongs to.
 * Email follows the email conversation. Text goes to the thread you last
 * used, unless the message starts with "New thread:".
 */
export async function resolveThread(input: {
  channel: 'text' | 'email';
  body: string;
  externalId?: string;
  subject?: string;
}): Promise<{ thread: Thread; body: string }> {
  let body = input.body;

  const requestedBody = newThreadBody(body);
  if (requestedBody !== null) {
    body = requestedBody;
    const title = (input.subject || body.split('\n')[0] || 'New thread').slice(0, 80);
    const thread = await createThread({ title, via: input.channel });
    if (input.externalId) await linkExternal(input.channel, input.externalId, thread.id);
    return { thread, body: body || title };
  }

  if (input.externalId) {
    const [link] = await sql<{ thread_id: string }[]>`
      select thread_id from channel_links where channel = ${input.channel} and external_id = ${input.externalId}`;
    if (link) {
      const thread = await getThread(link.thread_id);
      if (thread && !thread.hidden) return { thread: await reopen(thread), body };
    }
  }

  if (input.channel === 'email' && input.subject) {
    const cleaned = input.subject.replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim();
    if (cleaned) {
      const [match] = await sql<Thread[]>`
        select * from threads where not hidden and lower(title) = lower(${cleaned}) order by last_message_at desc limit 1`;
      const thread = match ? await reopen(match) : await createThread({ title: cleaned.slice(0, 80), via: 'email' });
      if (input.externalId) await linkExternal('email', input.externalId, thread.id);
      return { thread, body };
    }
  }

  const [recent] = await sql<Thread[]>`
    select * from threads where not hidden and status = 'open' order by last_message_at desc limit 1`;
  const thread = recent ?? (await createThread({ title: body.split('\n')[0]?.slice(0, 80) || 'New thread', via: input.channel }));
  if (input.externalId) await linkExternal(input.channel, input.externalId, thread.id);
  return { thread, body };
}

async function reopen(thread: Thread): Promise<Thread> {
  if (thread.status === 'open') return thread;
  await setThreadStatus(thread.id, 'open');
  return { ...thread, status: 'open' };
}

export async function linkExternal(channel: string, externalId: string, threadId: string) {
  await sql`
    insert into channel_links (channel, external_id, thread_id) values (${channel}, ${externalId}, ${threadId})
    on conflict (channel, external_id) do update set thread_id = excluded.thread_id`;
}

export async function addStep(input: { threadId: string; jobId?: string | null; label: string; detail?: string | null; status?: 'running' | 'done' | 'failed' }) {
  await sql`
    insert into run_steps (thread_id, job_id, label, detail, status)
    values (${input.threadId}, ${input.jobId ?? null}, ${input.label.slice(0, 200)}, ${input.detail?.slice(0, 2000) ?? null}, ${input.status ?? 'done'})`;
  publish({ type: 'step', threadId: input.threadId });
}
