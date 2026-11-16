import postgres from 'postgres';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, repoRoot } from './env.js';

export const sql = postgres(env.databaseUrl, {
  max: 10,
  onnotice: () => {},
  types: {
    // Keep dates as plain YYYY-MM-DD strings; a JS Date would shift them by timezone.
    date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v },
  },
});

/** Value for a jsonb column or parameter. */
export const json = (value: unknown) => sql.json(value as postgres.JSONValue);

export async function migrate(): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = path.join(repoRoot, 'apps/server/migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = await fs.readFile(path.join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
