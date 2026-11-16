import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobContext } from './prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// On the agent's computer the settings sit next to the program; in development they are the repo's .env.
config({ path: path.resolve(here, '../.env') });
if (process.env.DEMO_MODE !== 'true') config({ path: path.resolve(here, '../../../.env') });

const base = (process.env.SWITCHBOARD_URL || process.env.PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.AGENT_TOKEN ?? '';

async function request(method: string, route: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
  return fetch(`${base}/agent${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Agent-Machine-Id': process.env.AGENT_MACHINE_ID ?? '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export const switchboard = {
  base,

  async hello(): Promise<void> {
    const response = await request('POST', '/hello', {});
    if (!response.ok) throw new Error(`The switchboard refused the agent (${response.status}). Check AGENT_TOKEN and SWITCHBOARD_URL.`);
  },

  /** Waits up to about 20 seconds for work. */
  async next(): Promise<JobContext | null> {
    const response = await request('GET', '/next', undefined, 40_000);
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Switchboard returned ${response.status}`);
    return (await response.json()) as JobContext;
  },

  async event(jobId: string, event: Record<string, unknown>): Promise<void> {
    await request('POST', `/jobs/${jobId}/event`, event).catch((error) => {
      console.error('Could not report to the switchboard:', (error as Error).message);
    });
  },

  async status(jobId: string): Promise<string> {
    const response = await request('GET', `/jobs/${jobId}/status`);
    return response.ok ? ((await response.json()) as { status: string }).status : 'unknown';
  },

  async tool(name: string, body: { threadId: string; jobId: string; input: Record<string, unknown> }): Promise<unknown> {
    const response = await request('POST', `/tools/${name}`, body, 180_000);
    return response.json();
  },
};
