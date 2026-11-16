import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), execute: vi.fn(), use: vi.fn(), gate: vi.fn(),
}));
vi.mock('../db.js', () => ({ sql: mocks.sql, json: (value: unknown) => value }));
vi.mock('./composio.js', () => ({ composio: () => ({ sessions: { use: mocks.use } }) }));
vi.mock('./guardrails.js', () => ({ gate: mocks.gate }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.sql.mockResolvedValue([{ slug: 'gmail', name: 'Gmail', session_id: 'session_test', enabled: true }]);
  mocks.use.mockResolvedValue({ sessionId: 'session_test', execute: mocks.execute });
  mocks.execute.mockResolvedValue({ resultType: 'completed', data: { ok: true }, logId: 'log_test' });
  mocks.gate.mockResolvedValue({ status: 'pending_approval' });
});

describe('connected app boundaries', () => {
  it('allows only explicit Gmail reads to bypass the action gate', async () => {
    const { tools } = await import('./tools.js');
    await tools.connected_app_call!({ app: 'gmail', tool: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 5 } }, { threadId: 'thread', jobId: null });
    expect(mocks.execute).toHaveBeenCalledOnce(); expect(mocks.gate).not.toHaveBeenCalled();
  });
  it('requires the action gate for sends and includes the exact arguments for review', async () => {
    const { tools } = await import('./tools.js');
    const args = { recipient_email: 'test@example.com', subject: 'Test', body: 'Review this first' };
    await tools.connected_app_call!({ app: 'gmail', tool: 'GMAIL_SEND_EMAIL', arguments: args, summary: 'Send this test email.' }, { threadId: 'thread', jobId: null });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.gate).toHaveBeenCalledWith(expect.objectContaining({ action: 'connected_app_action', payload: { app: 'gmail', tool: 'GMAIL_SEND_EMAIL', arguments: args } }));
  });
  it('does not let an app use helper tools or the dedicated Zoho connection to bypass guardrails', async () => {
    const { validateAppCall } = await import('./connectedApps.js');
    expect(() => validateAppCall('gmail', 'COMPOSIO_MULTI_EXECUTE_TOOL', {})).toThrow();
    expect(() => validateAppCall('zoho', 'ZOHO_SEND_EMAIL', {})).toThrow();
    expect(() => validateAppCall('cloudinary', 'CLOUDINARY_DELETE_RESOURCE', {})).toThrow();
  });
  it('rechecks access before executing a previously approved action', async () => {
    const { executeAppTool } = await import('./connectedApps.js');
    await executeAppTool('gmail', 'GMAIL_GET_PROFILE', {});
    mocks.sql.mockResolvedValue([]);
    await expect(executeAppTool('gmail', 'GMAIL_SEND_EMAIL', {})).rejects.toThrow('Connect this app');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('reports provider failures even when no error text is supplied', async () => {
    const { executeAppTool } = await import('./connectedApps.js');
    mocks.execute.mockResolvedValue({ resultType: 'failed', data: {}, error: null, logId: 'log_failed' });
    await expect(executeAppTool('gmail', 'GMAIL_GET_PROFILE', {})).rejects.toThrow('log_failed');
  });
  it('bounds arguments and rejects malformed tool requests', async () => {
    const { validateAppCall } = await import('./connectedApps.js');
    for (const input of [null, [], { body: 'a'.repeat(33_000) }]) expect(() => validateAppCall('gmail', 'GMAIL_SEND_EMAIL', input)).toThrow();
  });
});
