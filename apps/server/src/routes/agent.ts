import { Hono } from 'hono';
import crypto from 'node:crypto';
import { sql } from '../db.js';
import { env } from '../env.js';
import { publish, subscribe } from '../bus.js';
import { addMessage, addStep, getThread, type Channel } from '../services/threads.js';
import { tools } from '../services/tools.js';
import { markAgentSeen } from '../services/instabox.js';
import { deliverEmailReply } from '../services/agentmail.js';
import { sendText } from '../services/photon.js';
import { markdownToHtml, markdownToPlain } from '../services/text.js';
import { getDefaults } from '../services/actions.js';
import { zohoCall, type ZohoServer } from '../services/zoho.js';
import { recordSync } from '../services/sync.js';

/** Routes used by the agent's computer and the sync pipeline. Not for browsers. */
export const agentRoutes = new Hono();

agentRoutes.use('*', async (c, next) => {
  const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = env.agentToken;
  const ok = expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return c.json({ error: 'Not authorised.' }, 401);
  // Sync pipelines share authentication but are not agent workers. Once a
  // machine is selected, only its explicitly configured worker may take jobs
  // or report activity; a leftover local development worker must stay offline.
  const workerRoute = /^\/(hello|next|jobs|tools)(\/|$)/.test(c.req.path.replace(/^\/agent/, ''));
  if (workerRoute && env.instaboxBoxId && c.req.header('X-Agent-Machine-Id') !== env.instaboxBoxId) {
    return c.json({ error: 'This worker is not configured for the selected InstaBox machine.' }, 403);
  }
  await next();
});

type Job = { id: string; thread_id: string; prompt: string; channel: Channel; status?: string };

async function claim(): Promise<Job | null> {
  const [agent] = await sql<{ value: { enabled?: boolean } }[]>`select value from settings where key = 'agent'`;
  if (agent?.value.enabled === false) return null;
  const [job] = await sql<Job[]>`
    update agent_jobs set status = 'running', started_at = now()
    where id = (
      select j.id from agent_jobs j
      where j.status = 'queued'
        and not exists (select 1 from agent_jobs r where r.thread_id = j.thread_id and r.status = 'running')
      order by j.created_at
      limit 1
      for update skip locked
    )
    returning id, thread_id, prompt, channel`;
  if (job) {
    publish({ type: 'job', threadId: job.thread_id, jobId: job.id, status: 'running' });
    publish({ type: 'threads' });
  }
  return job ?? null;
}

async function contextFor(job: Job) {
  const thread = await getThread(job.thread_id);
  const [agent] = await sql<{ value: { name: string } }[]>`select value from settings where key = 'agent'`;
  const memories = await sql<{ title: string; body: string }[]>`select title, body from memories order by created_at desc limit 40`;
  const guardrails = await sql<{ action: string; label: string; level: string }[]>`select action, label, level from guardrails order by position`;
  const drafts = await sql`
    select id as draft_id, name, subject, status, send_on from drafts where thread_id = ${job.thread_id} order by created_at`;
  const pending = await sql`select title from approvals where thread_id = ${job.thread_id} and status = 'pending'`;
  // Everything said before this message, for when the saved session cannot be resumed.
  const history = await sql<{ role: string; channel: string; body: string }[]>`
    select role, channel, body from (
      select role, channel, left(body, 4000) as body, created_at from messages
      where thread_id = ${job.thread_id} order by created_at desc offset 1 limit 40
    ) recent order by created_at`;
  return {
    job: { id: job.id, prompt: job.prompt, channel: job.channel },
    thread: { id: thread!.id, title: thread!.title, sessionId: thread!.sdk_session_id, series: thread!.series },
    context: {
      demoMode: env.demoMode,
      agentName: agent?.value.name ?? 'Penny',
      today: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' }),
      defaults: await getDefaults(),
      memories,
      guardrails,
      drafts,
      pendingApprovals: pending.map((p) => p.title),
      history,
    },
  };
}

/** Called once when the agent process starts: anything it was working on when it stopped is put back in the queue. */
agentRoutes.post('/hello', async (c) => {
  markAgentSeen();
  const requeued = await sql`update agent_jobs set status = 'queued', started_at = null where status = 'running' returning id`;
  publish({ type: 'threads' });
  return c.json({ ok: true, requeued: requeued.length });
});

/** Long poll for the next job. Returns 204 when there is nothing to do. */
agentRoutes.get('/next', async (c) => {
  markAgentSeen();
  let job = await claim();
  if (!job) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 20_000);
      const off = subscribe((event) => {
        if (event.type === 'job' && event.status === 'queued') done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    markAgentSeen();
    job = await claim();
  }
  if (!job) return c.body(null, 204);
  return c.json(await contextFor(job));
});

agentRoutes.post('/jobs/:id/event', async (c) => {
  markAgentSeen();
  const jobId = c.req.param('id');
  const event = await c.req.json<{ type: string; text?: string; sessionId?: string; label?: string; detail?: string; status?: 'running' | 'done' | 'failed' }>();
  const [job] = await sql<Job[]>`select id, thread_id, prompt, channel, status from agent_jobs where id = ${jobId}`;
  if (!job) return c.json({ error: 'Unknown job.' }, 404);
  // A job the owner stopped is finished as far as the thread is concerned.
  if (job.status !== 'running') return c.json({ ok: true, ignored: true });

  switch (event.type) {
    case 'session':
      if (event.sessionId) await sql`update threads set sdk_session_id = ${event.sessionId} where id = ${job.thread_id}`;
      break;
    case 'delta':
      if (event.text) publish({ type: 'delta', threadId: job.thread_id, jobId, text: event.text });
      break;
    case 'step':
      if (event.label) await addStep({ threadId: job.thread_id, jobId, label: event.label, detail: event.detail, status: event.status });
      break;
    case 'final': {
      const text = (event.text ?? '').trim();
      if (text) {
        await addMessage({ threadId: job.thread_id, role: 'agent', channel: job.channel, body: text, meta: { job_id: jobId } });
        await deliver(job, text).catch(async (error) => {
          await addMessage({
            threadId: job.thread_id,
            role: 'system',
            channel: job.channel,
            body: `The reply could not be sent by ${job.channel === 'text' ? 'text' : 'email'}: ${(error as Error).message}`,
          });
        });
      }
      await sql`update agent_jobs set status = 'done', finished_at = now() where id = ${jobId}`;
      publish({ type: 'job', threadId: job.thread_id, jobId, status: 'done' });
      publish({ type: 'threads' });
      break;
    }
    case 'error': {
      await sql`update agent_jobs set status = 'failed', finished_at = now(), error = ${event.text ?? 'Unknown error'} where id = ${jobId}`;
      await addMessage({ threadId: job.thread_id, role: 'system', channel: job.channel, body: `Something went wrong: ${event.text ?? 'unknown error'}` });
      publish({ type: 'job', threadId: job.thread_id, jobId, status: 'failed' });
      publish({ type: 'threads' });
      break;
    }
  }
  return c.json({ ok: true });
});

/** Replies go back out on the channel the message came in on. Chat needs nothing: the browser already has it. */
async function deliver(job: Job, text: string) {
  if (env.demoMode) return;
  if (job.channel === 'text') {
    await sendText(markdownToPlain(text), `reply-${job.id}`);
  } else if (job.channel === 'email') {
    const thread = await getThread(job.thread_id);
    await deliverEmailReply(job.thread_id, markdownToHtml(text), markdownToPlain(text), thread?.title ?? 'Update');
  }
}

agentRoutes.get('/jobs/:id/status', async (c) => {
  const [job] = await sql<{ status: string }[]>`select status from agent_jobs where id = ${c.req.param('id')}`;
  return c.json({ status: job?.status ?? 'unknown' });
});

agentRoutes.post('/tools/:name', async (c) => {
  markAgentSeen();
  const name = c.req.param('name');
  const tool = tools[name];
  if (!tool) return c.json({ error: `There is no tool called ${name}.` }, 404);
  const { threadId, jobId, input } = await c.req.json<{ threadId: string; jobId?: string; input?: Record<string, unknown> }>();
  try {
    return c.json(await tool(input ?? {}, { threadId, jobId: jobId ?? null }));
  } catch (error) {
    return c.json({ error: (error as Error).message });
  }
});

// --- Used by the dlt pipeline ---------------------------------------------------

const READ_ONLY = /^(ZohoCampaigns_(list|get|search)|ZohoCRM_(get|executeCOQLQuery))/;

/** Lets the sync pipeline read Zoho through the switchboard's sign-in. Read tools only. */
agentRoutes.post('/zoho/call', async (c) => {
  const { server, tool, args } = await c.req.json<{ server: ZohoServer; tool: string; args?: Record<string, unknown> }>();
  if (!READ_ONLY.test(tool)) return c.json({ error: 'Only read tools can be called from the pipeline.' }, 400);
  try {
    return c.json({ data: await zohoCall(server, tool, args ?? {}) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

agentRoutes.post('/sync/record', async (c) => {
  const body = await c.req.json<{ source: string; status: string; detail?: string; rows?: number }>();
  await recordSync(body.source, body.status, body.detail ?? null, body.rows ?? null);
  return c.json({ ok: true });
});
