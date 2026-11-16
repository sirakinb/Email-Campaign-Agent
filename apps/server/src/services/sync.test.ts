import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), spawn: vi.fn(), connected: vi.fn() }));
vi.mock('../db.js', () => ({ sql: mocks.sql }));
vi.mock('../env.js', () => ({ env: { demoMode: false, databaseUrl: 'postgres://test', port: 8787, agentToken: 'test' }, repoRoot: '/project' }));
vi.mock('../bus.js', () => ({ publish: vi.fn() }));
vi.mock('./zoho.js', () => ({ isConnected: mocks.connected }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { runSync } from './sync.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connected.mockResolvedValue(false);
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

describe('template data sources', () => {
  it('passes the owner’s saved listings URL to the importer', async () => {
    mocks.sql.mockResolvedValue([{ value: { listings_url: 'https://my-business.appfolio.com/listings/' } }]);
    expect((await runSync()).ok).toBe(true);
    const [, args, options] = mocks.spawn.mock.calls[0]!;
    expect(args.at(-1)).toBe('appfolio');
    expect(options.env.LISTINGS_URL).toBe('https://my-business.appfolio.com/listings/');
  });

  it('does not launch a default importer when no sources are configured', async () => {
    vi.stubEnv('LISTINGS_URL', '');
    try {
      mocks.sql.mockResolvedValue([{ value: { listings_url: '' } }]);
      expect((await runSync()).ok).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('can sync Zoho without a listings connection', async () => {
    vi.stubEnv('LISTINGS_URL', '');
    try {
      mocks.sql.mockResolvedValue([{ value: { listings_url: '' } }]);
      mocks.connected.mockResolvedValue(true);
      expect((await runSync()).ok).toBe(true);
      const [, args, options] = mocks.spawn.mock.calls[0]!;
      expect(args.at(-1)).toBe('zoho');
      expect(args).not.toContain('appfolio');
      expect(options.env.LISTINGS_URL).toBe('');
    } finally { vi.unstubAllEnvs(); }
  });
});
