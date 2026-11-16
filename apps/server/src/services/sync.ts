import { spawn } from 'node:child_process';
import path from 'node:path';
import { sql } from '../db.js';
import { env, repoRoot } from '../env.js';
import { publish } from '../bus.js';
import { isConnected } from './zoho.js';

export async function recordSync(source: string, status: string, detail: string | null, rows: number | null) {
  await sql`
    insert into sync_runs (source, status, detail, rows, finished_at)
    values (${source}, ${status}, ${detail}, ${rows}, now())`;
  if (source === 'appfolio' || source === 'zoho_campaigns') {
    await sql`
      update connections set status = ${status === 'ok' ? 'connected' : 'error'}, checked_at = now()
      where id = ${source} and (${source} = 'appfolio' or status <> 'not_connected')`;
  }
  publish({ type: 'sync' });
}

let running: Promise<{ ok: boolean; output: string }> | null = null;
export const syncRunning = () => running !== null;

/**
 * Runs the dlt pipeline in /pipelines. Listings are read from the public
 * AppFolio page; Zoho is read through this server's sign-in. The pipeline
 * reports each source's result back to /agent/sync/record.
 */
export function runSync(): Promise<{ ok: boolean; output: string }> {
  if (env.demoMode) return Promise.resolve({ ok: true, output: 'Demo fixtures are already loaded. External sync is disabled.' });
  if (running) return running;
  running = (async () => {
    const [defaults] = await sql<{ value: { listings_url?: string } }[]>`select value from settings where key = 'defaults'`;
    const listingsUrl = defaults?.value.listings_url || process.env.LISTINGS_URL || '';
    const sources = [...(listingsUrl ? ['appfolio'] : []), ...((await isConnected('zoho_campaigns')) ? ['zoho'] : [])];
    if (!sources.length) return { ok: false, output: 'Add your listings URL in Settings or connect Zoho Campaigns before syncing.' };
    return new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = spawn('uv', ['run', '--project', path.join(repoRoot, 'pipelines'), 'python', '-m', 'sync', ...sources], {
        cwd: path.join(repoRoot, 'pipelines'),
        env: {
          ...process.env,
          DATABASE_URL: env.databaseUrl,
          SWITCHBOARD_URL: `http://127.0.0.1:${env.port}`,
          AGENT_TOKEN: env.agentToken,
          LISTINGS_URL: listingsUrl,
        },
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', (error) => resolve({ ok: false, output: error.message }));
      child.on('close', (code) => resolve({ ok: code === 0, output: output.slice(-4000) }));
    });
  })().finally(() => {
    running = null;
    publish({ type: 'sync' });
  });
  publish({ type: 'sync' });
  return running;
}
