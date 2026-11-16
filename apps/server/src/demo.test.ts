import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('demo isolation', () => {
  it('rejects interactive desktop control before contacting InstaBox', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const { screenLink } = await import('./services/instabox.js');
      await expect(screenLink(true)).rejects.toThrow('read-only');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('refuses client connector credentials before startup', async () => {
    const { assertDemoConfiguration } = await import('./demo.js');
    for (const key of ['ZOHO_CLIENT_SECRET', 'PHOTON_API_KEY', 'AGENTMAIL_API_KEY', 'COMPOSIO_API_KEY', 'CLOUDINARY_API_SECRET', 'FAL_KEY', 'ANTHROPIC_API_KEY']) {
      expect(() => assertDemoConfiguration({ DEMO_MODE: 'true', DEMO_INSTANCE_ID: 'test', [key]: 'forbidden' })).toThrow('refuses live integration');
    }
    expect(() => assertDemoConfiguration({ DEMO_MODE: 'true' })).toThrow('DEMO_INSTANCE_ID');
    expect(() => assertDemoConfiguration({ DEMO_MODE: 'true', DEMO_INSTANCE_ID: 'test' })).not.toThrow();
  });

  it('never permits demo reset in the live workspace', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    const { initializeDemo } = await import('./demo.js');
    await expect(initializeDemo(true)).rejects.toThrow('unavailable in the live workspace');
  });

  it('blocks Zoho and connected app execution before any network call', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { zohoCall } = await import('./services/zoho.js');
    const { executeAppTool, listConnectedApps, appsConfigured } = await import('./services/connectedApps.js');
    await expect(zohoCall('zoho_campaigns', 'ZohoCampaigns_listCampaigns', {})).rejects.toThrow('disabled');
    await expect(executeAppTool('gmail', 'GMAIL_GET_PROFILE', {})).rejects.toThrow('disabled');
    expect(await listConnectedApps()).toEqual([]);
    expect(appsConfigured()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
