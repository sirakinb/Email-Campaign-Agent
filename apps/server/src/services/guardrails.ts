import { json, sql } from '../db.js';
import { publish } from '../bus.js';
import { addMessage, enqueueJob, type Channel } from './threads.js';
import { executors, type ActionName } from './actions.js';

export type Level = 'draft_only' | 'approve_first' | 'autonomous';

export type GateResult =
  | { status: 'done'; result: unknown }
  | { status: 'pending_approval'; approvalId: string; note: string }
  | { status: 'blocked'; note: string };

export async function levelOf(action: ActionName): Promise<Level> {
  const [row] = await sql<{ level: Level }[]>`select level from guardrails where action = ${action}`;
  return row?.level ?? 'approve_first';
}

/**
 * Every action that changes something outside a conversation goes through
 * here. The level set in Settings decides whether it runs now, waits for a
 * person, or is refused. The agent cannot change levels or approve itself.
 */
export async function gate(input: {
  action: ActionName;
  threadId: string | null;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
}): Promise<GateResult> {
  const level = await levelOf(input.action);

  if (level === 'draft_only') {
    return {
      status: 'blocked',
      note: 'This action is set to draft only in Settings, so it was not carried out. Describe what you would do and leave it for the owner.',
    };
  }

  if (level === 'autonomous') {
    const result = await executors[input.action](input.payload, input.threadId);
    return { status: 'done', result };
  }

  const [approval] = await sql<{ id: string }[]>`
    insert into approvals (thread_id, action, title, summary, payload)
    values (${input.threadId}, ${input.action}, ${input.title.slice(0, 200)}, ${input.summary.slice(0, 2000)}, ${json(input.payload)})
    returning id`;
  publish({ type: 'approval', approvalId: approval!.id, threadId: input.threadId });
  publish({ type: 'threads' });
  return {
    status: 'pending_approval',
    approvalId: approval!.id,
    note: 'This needs the owner\'s approval. It has been put in front of them. Tell them briefly what you are asking for and stop; you will be told when they decide.',
  };
}

type Approval = {
  id: string;
  thread_id: string | null;
  action: ActionName;
  title: string;
  payload: Record<string, unknown>;
  status: string;
};

export async function decide(approvalId: string, approve: boolean, via: Channel): Promise<{ status: string; error?: string }> {
  // Claim the row first so two clicks, or a click and a text, cannot both run it.
  const [approval] = await sql<Approval[]>`
    update approvals
    set status = ${approve ? 'approved' : 'rejected'}, decided_at = now(), decided_via = ${via}
    where id = ${approvalId} and status = 'pending'
    returning id, thread_id, action, title, payload, status`;
  if (!approval) return { status: 'already_decided' };
  publish({ type: 'approval', approvalId, threadId: approval.thread_id });

  if (!approve) {
    await tellThread(approval, `Declined: ${approval.title}.`, `The owner declined "${approval.title}". Do not carry it out. Ask what they would like changed, briefly.`, via);
    return { status: 'rejected' };
  }

  try {
    const result = await executors[approval.action](approval.payload, approval.thread_id);
    await sql`update approvals set status = 'done', result = ${json(result ?? {})} where id = ${approvalId}`;
    publish({ type: 'approval', approvalId, threadId: approval.thread_id });
    await tellThread(
      approval,
      `Approved and done: ${approval.title}.`,
      `The owner approved "${approval.title}" and it has been carried out. Result: ${JSON.stringify(result ?? {}).slice(0, 1500)}. Confirm in one or two sentences and continue with anything that was waiting on this.`,
      via,
    );
    return { status: 'done' };
  } catch (error) {
    const message = (error as Error).message;
    await sql`update approvals set status = 'failed', result = ${json({ error: message })} where id = ${approvalId}`;
    publish({ type: 'approval', approvalId, threadId: approval.thread_id });
    await tellThread(
      approval,
      `Approved, but it failed: ${approval.title}. ${message}`,
      `The owner approved "${approval.title}" but carrying it out failed with: ${message}. Explain plainly what went wrong and what the options are.`,
      via,
    );
    return { status: 'failed', error: message };
  }
}

async function tellThread(approval: Approval, note: string, prompt: string, via: Channel) {
  if (!approval.thread_id) return;
  await addMessage({ threadId: approval.thread_id, role: 'system', channel: via, body: note, meta: { approval_id: approval.id } });
  await enqueueJob(approval.thread_id, prompt, via);
}

const YES = /^\s*(approve|approved|yes|yep|ok|okay|go ahead|do it|sounds good)\b[\s.!]*$/i;
const NO = /^\s*(reject|rejected|decline|no|nope|don't|do not|hold off)\b[\s.!]*$/i;

/**
 * Lets a one-word text or email answer an approval. Only when the reply is
 * unambiguous and exactly one approval is waiting in that thread; anything
 * else goes to the agent as a normal message.
 */
export async function tryDecideFromReply(threadId: string, body: string, via: Channel): Promise<boolean> {
  const approve = YES.test(body) ? true : NO.test(body) ? false : null;
  if (approve === null) return false;
  const pending = await sql<{ id: string }[]>`select id from approvals where thread_id = ${threadId} and status = 'pending'`;
  if (pending.length !== 1) return false;
  await decide(pending[0]!.id, approve, via);
  return true;
}
