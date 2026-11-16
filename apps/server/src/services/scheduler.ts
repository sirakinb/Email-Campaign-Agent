import { Cron } from 'croner';
import { sql } from '../db.js';
import { addMessage, createThread, enqueueJob } from './threads.js';
import { runSync } from './sync.js';
import { pollInbox } from './agentmail.js';
import { wakeForWork } from './instabox.js';

type Automation = { id: string; label: string; cron: string; kind: 'sync' | 'prompt'; prompt: string | null; enabled: boolean };

const jobs = new Map<string, Cron>();

export async function runAutomation(id: string): Promise<{ threadId?: string; status: string }> {
  const [automation] = await sql<Automation[]>`select * from automations where id = ${id}`;
  if (!automation) throw new Error('No such automation.');
  let status = 'ok';
  let threadId: string | undefined;
  try {
    if (automation.kind === 'sync') {
      const result = await runSync();
      if (!result.ok) status = 'failed';
    } else if (automation.prompt) {
      const thread = await createThread({
        title: `${automation.label}, ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`,
        via: 'automation',
      });
      threadId = thread.id;
      await addMessage({ threadId: thread.id, role: 'user', channel: 'automation', body: automation.prompt, meta: { automation: automation.id } });
      await enqueueJob(thread.id, automation.prompt, 'automation');
      void wakeForWork();
    }
  } catch (error) {
    status = 'failed';
    console.error(`Automation ${id} failed:`, (error as Error).message);
  }
  await sql`update automations set last_run_at = now(), last_status = ${status} where id = ${id}`;
  return { threadId, status };
}

/** Next run times, for Today and Settings. */
export function nextRun(id: string): string | null {
  return jobs.get(id)?.nextRun()?.toISOString() ?? null;
}

export async function startScheduler() {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  const automations = await sql<Automation[]>`select * from automations`;
  for (const automation of automations) {
    const job = new Cron(automation.cron, { timezone: 'America/New_York', paused: !automation.enabled, protect: true }, () => {
      void runAutomation(automation.id);
    });
    jobs.set(automation.id, job);
  }
}

export function setAutomationEnabled(id: string, enabled: boolean) {
  const job = jobs.get(id);
  if (!job) return;
  if (enabled) job.resume();
  else job.pause();
}

/** Checks the agent's inbox every 20 seconds. */
export function startInboxPolling() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if ((await pollInbox()) > 0) void wakeForWork();
    } catch (error) {
      console.error('Inbox check failed:', (error as Error).message);
    } finally {
      busy = false;
    }
  }, 20_000);
}
