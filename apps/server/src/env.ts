import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// A local demo must never inherit the live workspace's credentials.
if (process.env.DEMO_MODE !== 'true') config({ path: path.join(repoRoot, '.env') });

const get = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export const env = {
  demoMode: get('DEMO_MODE') === 'true',
  port: Number(get('PORT', '8787')),
  publicUrl: get('PUBLIC_URL', 'http://localhost:8787').replace(/\/$/, ''),
  databaseUrl: get('DATABASE_URL', 'postgres://localhost/email_agent'),
  /** Shared secret between the switchboard and the agent's computer. */
  agentToken: get('AGENT_TOKEN'),
  /** When empty the app is open, which is only acceptable on localhost. */
  appPassword: get('APP_PASSWORD'),
  sessionSecret: get('SESSION_SECRET', 'dev-session-secret'),
  ownerEmail: get('OWNER_EMAIL'),
  ownerPhone: get('OWNER_PHONE'),
  instaboxKey: get('INSTABOX_API_KEY'),
  instaboxBoxId: get('INSTABOX_BOX_ID'),
  photonKey: get('PHOTON_API_KEY'),
  photonWebhookSecret: get('PHOTON_WEBHOOK_SECRET'),
  agentmailKey: get('AGENTMAIL_API_KEY'),
  agentmailInbox: get('AGENTMAIL_INBOX'),
  agentmailWebhookSecret: get('AGENTMAIL_WEBHOOK_SECRET'),
  falKey: get('FAL_KEY'),
  cloudinaryKey: get('CLOUDINARY_API_KEY'),
  cloudinarySecret: get('CLOUDINARY_API_SECRET'),
  cloudinaryCloud: get('CLOUDINARY_CLOUD_NAME'),
  zohoCampaignsMcpUrl: get('ZOHO_CAMPAIGNS_MCP_URL'),
  zohoCrmMcpUrl: get('ZOHO_CRM_MCP_URL'),
  webDist: get('WEB_DIST', path.join(repoRoot, 'apps/web/dist')),
  isProd: get('NODE_ENV') === 'production',
};
