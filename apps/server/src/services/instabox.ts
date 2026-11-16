import crypto from 'node:crypto';
import { sql } from '../db.js';
import { env } from '../env.js';
import { publish } from '../bus.js';

/**
 * The agent's computer. The switchboard can wake it, pause it, start the
 * agent process on it and hand out a link to watch or drive its screen.
 */
const BASE = 'https://api.instabox.sh';

export const boxConfigured = () => Boolean(env.instaboxKey && env.instaboxBoxId);

type Machine = {
  id: string;
  name: string;
  state: string;
  runtime?: { ready?: boolean };
  autoSuspendedAt?: string | null;
  cooldownUntil?: string | null;
  spec?: { vcpus: number; memMiB: number };
};

async function call<T>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'X-API-Key': env.instaboxKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {}
    throw new Error(`InstaBox: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const machinePath = () => `/v1/machines/${env.instaboxBoxId}`;

export type ComputerStatus = {
  configured: boolean;
  state: 'off' | 'asleep' | 'starting' | 'on' | 'error' | 'unknown';
  rawState?: string;
  name?: string;
  size?: string;
  /** True when the agent process on the machine has checked in recently. */
  agentOnline: boolean;
  lastSeenAt: string | null;
  cooldownUntil?: string | null;
  error?: string;
};

let lastSeen: number | null = null;
export const markAgentSeen = () => {
  const wasOnline = agentOnline();
  lastSeen = Date.now();
  if (!wasOnline) publish({ type: 'computer' });
};
export const agentOnline = () => lastSeen !== null && Date.now() - lastSeen < 45_000;

export async function computerStatus(): Promise<ComputerStatus> {
  const base = { agentOnline: agentOnline(), lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null };
  if (!boxConfigured()) return { configured: false, state: 'unknown', ...base };
  try {
    const m = await call<Machine>('GET', machinePath());
    const state: ComputerStatus['state'] =
      m.state === 'running'
        ? 'on'
        : m.state === 'suspended' || m.state === 'suspending'
          ? 'asleep'
          : m.state === 'stopped' || m.state === 'stopping'
            ? 'off'
            : m.state === 'error'
              ? 'error'
              : 'starting';
    return {
      configured: true,
      state,
      rawState: m.state,
      name: m.name,
      size: m.spec ? `${m.spec.vcpus} vCPU, ${Math.round(m.spec.memMiB / 1024)} GB` : undefined,
      cooldownUntil: m.cooldownUntil ?? null,
      ...base,
    };
  } catch (error) {
    return { configured: true, state: 'error', error: (error as Error).message, ...base };
  }
}

async function waitOperation(operationId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = await call<{ state: string; error?: { message?: string } | null }>('GET', `/v1/operations/${operationId}?wait=25s`);
    if (op.state === 'succeeded') return;
    if (op.state === 'failed') throw new Error(`InstaBox: ${op.error?.message ?? 'the operation failed'}`);
  }
  throw new Error('InstaBox took too long to respond.');
}

/** Turns the computer on, from any state, and makes sure the agent process is running. */
export async function powerOn(): Promise<void> {
  const m = await call<Machine>('GET', machinePath());
  if (m.state === 'suspended') {
    const op = await call<{ id: string }>('POST', `${machinePath()}/resume`, undefined, true);
    await waitOperation(op.id);
  } else if (m.state === 'stopped') {
    const op = await call<{ id: string }>('POST', `${machinePath()}/start`, undefined, true);
    await waitOperation(op.id);
  }
  publish({ type: 'computer' });
  await ensureAgentProcess();
}

/** Pauses the computer. Memory and processes are kept, and nothing is billed while paused. */
export async function powerOff(): Promise<void> {
  const m = await call<Machine>('GET', machinePath());
  if (m.state === 'running') {
    const op = await call<{ id: string }>('POST', `${machinePath()}/suspend`, undefined, true);
    await waitOperation(op.id);
  }
  lastSeen = null;
  publish({ type: 'computer' });
}

export async function exec(cmd: string, timeoutSeconds = 60): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return call('POST', `${machinePath()}/exec`, { cmd, timeoutSeconds });
}

/** Starts the agent process if it is not already running. Safe to call repeatedly. */
export async function ensureAgentProcess(): Promise<void> {
  if (!boxConfigured()) return;
  await exec(
    `pgrep -f "[e]a-agent/dist/index.js" >/dev/null || (cd /data/home/ea-agent && nohup ./run.sh >> /data/home/ea-agent/agent.log 2>&1 &)`,
    30,
  );
}

/**
 * Wakes the computer when there is work and the owner has left the agent
 * switched on. Called whenever a job is queued.
 */
export async function wakeForWork(): Promise<void> {
  if (!boxConfigured() || agentOnline()) return;
  const [row] = await sql<{ value: { enabled?: boolean } }[]>`select value from settings where key = 'agent'`;
  if (row?.value.enabled === false) return;
  try {
    await powerOn();
  } catch (error) {
    console.error('Could not wake the agent computer:', (error as Error).message);
  }
}

export async function screenLink(control: boolean): Promise<{ url: string; expiresAt: string }> {
  if (env.demoMode && control) throw new Error('The demo desktop is read-only.');
  if (env.demoMode) await powerOn();
  await call('POST', `${machinePath()}/desktop`, { action: 'start', width: 1280, height: 800 });
  if (env.demoMode) {
    // A separate unsigned-in browser profile shows only the fictional listings.
    // Never open a terminal or reuse the client's machine/browser profile.
    const url = new URL('/demo/properties', env.publicUrl).href.replaceAll("'", "'\\''");
    const result = await exec(`pgrep -f '[c]hromium.*--user-data-dir=/data/home/penny-demo-browser' >/dev/null || (DISPLAY=:1 nohup chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir=/data/home/penny-demo-browser --app='${url}' --start-maximized > /tmp/penny-demo-browser.log 2>&1 < /dev/null &)`, 30);
    if (result.exitCode !== 0) throw new Error('Could not prepare the fictional demo desktop.');
  }
  if (control) await call('POST', `${machinePath()}/desktop`, { action: 'takeover' });
  return call('POST', `${machinePath()}/desktop/stream`, { viewOnly: !control, ttlSeconds: 3600 });
}

export async function handBack(): Promise<void> {
  await call('POST', `${machinePath()}/desktop`, { action: 'handback' });
}
