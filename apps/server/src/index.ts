import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { migrate } from './db.js';
import { api } from './routes/api.js';
import { agentRoutes } from './routes/agent.js';
import { finishConnect } from './services/zoho.js';
import { startInboxPolling, startScheduler } from './services/scheduler.js';
import { startTextChannel } from './services/photon.js';
import { assertDemoConfiguration, demoHomeSvg, initializeDemo, DEMO_HOMES } from './demo.js';
import { sql } from './db.js';
import { agentOnline, wakeForWork } from './services/instabox.js';

assertDemoConfiguration();

if (env.isProd && (!env.appPassword || !env.agentToken || env.sessionSecret.startsWith('dev-'))) {
  console.error('Refusing to start in production without APP_PASSWORD, AGENT_TOKEN and a real SESSION_SECRET.');
  process.exit(1);
}

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (env.demoMode) await initializeDemo();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
if (env.demoMode) {
  app.get('/demo-assets/:file', (c) => {
    const svg = demoHomeSvg(c.req.param('file').replace(/\.svg$/, ''));
    return svg ? c.body(svg, 200, { 'Content-Type': 'image/svg+xml' }) : c.notFound();
  });
  app.get('/demo/properties/:id?', (c) => {
    const homes = DEMO_HOMES.filter((home) => !c.req.param('id') || home.id === c.req.param('id'));
    return c.html(`<html><head><title>Willow & Finch · Fictional homes</title><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="background:#101012;color:#eee;font:18px system-ui;padding:32px;max-width:900px;margin:auto"><p style="color:#b58aff">FICTIONAL DEMO · No real properties</p><h1>Willow & Finch Rentals</h1>${homes.map((home) => `<article><img style="width:100%;max-width:600px" src="/demo-assets/${home.id}.svg"/><h2>${home.address}</h2><p>${home.description}</p><p>$${home.rent}/month · ${home.beds} bedrooms</p></article>`).join('')}</body></html>`);
  });
}
app.route('/api', api);
app.route('/agent', agentRoutes);

/** Zoho sends the browser back here after sign-in. */
app.get('/oauth/callback', async (c) => {
  if (env.demoMode) return c.json({ error: 'Live connections are disabled in this demo.' }, 403);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.redirect('/settings?connect=failed');
  try {
    const server = await finishConnect(state, code);
    return c.redirect(`/settings?connected=${server}`);
  } catch (error) {
    console.error('Zoho sign-in failed:', (error as Error).message);
    return c.redirect('/settings?connect=failed');
  }
});

// The built web app, when present. In development Vite serves it instead.
if (fs.existsSync(path.join(env.webDist, 'index.html'))) {
  const root = path.relative(process.cwd(), env.webDist) || '.';
  app.use('/assets/*', serveStatic({ root }));
  app.use('/favicon.svg', serveStatic({ root }));
  const index = fs.readFileSync(path.join(env.webDist, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index));
}

if (!env.demoMode) {
  await startScheduler();
  startInboxPolling();
  void startTextChannel();
} else {
  // Recover queued work if a message arrived just as the idle demo computer
  // suspended, or if its worker stopped. This never starts scheduled campaigns.
  let recovering = false;
  setInterval(async () => {
    if (recovering || agentOnline()) return;
    recovering = true;
    try {
      const [job] = await sql`select id from agent_jobs where status in ('queued','running') limit 1`;
      if (job) await wakeForWork();
    } catch (error) { console.error('Demo worker recovery:', (error as Error).message); }
    finally { recovering = false; }
  }, 30_000).unref();
}

serve({ fetch: app.fetch, port: env.port, hostname: env.isProd ? '0.0.0.0' : '127.0.0.1' }, (info) => {
  console.log(`Command center switchboard listening on http://localhost:${info.port}`);
});
