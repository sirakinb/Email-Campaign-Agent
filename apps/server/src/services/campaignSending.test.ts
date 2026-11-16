import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), remote: vi.fn(), send: vi.fn(), env: { demoMode: false } }));
vi.mock('../db.js', () => ({ sql: Object.assign(mocks.sql, { begin: (fn: (tx: unknown) => unknown) => fn(mocks.sql) }), json: (v: unknown) => v }));
vi.mock('../env.js', () => ({ env: mocks.env }));
vi.mock('../bus.js', () => ({ publish: vi.fn() }));
vi.mock('./zoho.js', () => ({ getCampaignForSending: mocks.remote, sendCampaignNow: mocks.send }));
import { executeLiveSend, fingerprint, prepareLiveSend, uploadFingerprint } from './campaignSending.js';

const defaults = { sender_email: 'owner@example.com', sender_name: 'Example', list_id: 'list-1', list_name: 'Leads', topic_id: 'topic-1', topic_name: 'News', listings_url: '' };
let draft: any;
let level: string;
let approved: boolean;
let claimed: boolean;
let resultStatus: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.demoMode = false;
  level = 'autonomous'; approved = false; claimed = false; resultStatus = '';
  draft = { id: 'draft-1', name: 'Campaign', subject: 'Available homes', preheader: '', html: '<p>Approved content</p>', zoho_campaign_id: 'campaign-1', send_locked: false };
  draft.uploaded_fingerprint = uploadFingerprint(draft, defaults);
  draft.uploaded_provider_fingerprint = fingerprint('original');
  mocks.remote.mockResolvedValue({ subject: draft.subject, sender_email: defaults.sender_email, list_ids: [defaults.list_id], topic_id: defaults.topic_id, revision: 'original' });
  mocks.send.mockResolvedValue({ ok: true });
  mocks.sql.mockImplementation(async (parts: TemplateStringsArray, ...values: any[]) => {
    const q = parts.join('?');
    if (q.includes('select') && q.includes('from drafts')) return [{ ...draft }];
    if (q.includes('select') && q.includes('from settings')) return [{ value: { ...defaults } }];
    if (q.includes('select') && q.includes('from guardrails')) return [{ level, locked: false }];
    if (q.includes('select') && q.includes('from approvals')) return approved && values[0] === 'approval-1' ? [{ id: 'approval-1' }] : [];
    if (q.includes('select') && q.includes('campaign_send_attempts')) return claimed ? [{ status: resultStatus }] : [];
    if (q.includes('insert into campaign_send_attempts')) {
      if (claimed) return [];
      claimed = true; resultStatus = 'submitting'; return [{ campaign_id: 'campaign-1' }];
    }
    if (q.includes('set send_locked')) draft.send_locked = true;
    if (q.includes("status = 'submitted'")) resultStatus = 'submitted';
    if (q.includes("status = 'unknown'")) resultStatus = 'unknown';
    return [];
  });
});

describe('optional live campaign sending', () => {
  it('blocks execution when the owner has turned live sending off', async () => {
    const snapshot = await prepareLiveSend(draft.id); level = 'draft_only';
    await expect(executeLiveSend(snapshot)).rejects.toThrow('turned off');
    expect(mocks.send).not.toHaveBeenCalled(); expect(claimed).toBe(false);
  });
  it('requires actual owner approval when approve-first is selected', async () => {
    const snapshot = await prepareLiveSend(draft.id); level = 'approve_first';
    await expect(executeLiveSend(snapshot)).rejects.toThrow('approval');
    expect(mocks.send).not.toHaveBeenCalled();
    approved = true;
    await expect(executeLiveSend(snapshot, 'approval-1')).resolves.toMatchObject({ status: 'submitted' });
  });
  it('sends an unchanged uploaded campaign when automatic sending is selected', async () => {
    const snapshot = await prepareLiveSend(draft.id);
    await executeLiveSend(snapshot);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('campaign-1');
    expect(resultStatus).toBe('submitted'); expect(draft.send_locked).toBe(true);
  });
  it('rejects edits after approval was requested', async () => {
    const snapshot = await prepareLiveSend(draft.id); draft.html = '<p>Changed content</p>';
    await expect(executeLiveSend(snapshot)).rejects.toThrow('changed');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects a changed remote campaign revision', async () => {
    const snapshot = await prepareLiveSend(draft.id);
    mocks.remote.mockResolvedValue({ subject: draft.subject, sender_email: defaults.sender_email, list_ids: [defaults.list_id], topic_id: defaults.topic_id, revision: 'changed' });
    await expect(executeLiveSend(snapshot)).rejects.toThrow('changed');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects a different or expanded provider mailing list', async () => {
    mocks.remote.mockResolvedValue({ subject: draft.subject, sender_email: defaults.sender_email, list_ids: ['list-1', 'list-2'], topic_id: defaults.topic_id, revision: 'original' });
    await expect(prepareLiveSend(draft.id)).rejects.toThrow('does not match');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('retains a durable claim on provider failure and refuses retries', async () => {
    const snapshot = await prepareLiveSend(draft.id);
    mocks.send.mockRejectedValue(new Error('Network timeout'));
    await expect(executeLiveSend(snapshot)).rejects.toThrow('Do not retry');
    expect(resultStatus).toBe('unknown'); expect(draft.send_locked).toBe(true);
    await expect(executeLiveSend(snapshot)).rejects.toThrow('already attempted');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('allows at most one concurrent send attempt for a campaign', async () => {
    const snapshot = await prepareLiveSend(draft.id);
    const results = await Promise.allSettled([executeLiveSend(snapshot), executeLiveSend(snapshot)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('refuses demo sends without contacting a provider', async () => {
    mocks.env.demoMode = true;
    await expect(prepareLiveSend(draft.id)).rejects.toThrow('disabled');
    expect(mocks.remote).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('requires a fresh upload for drafts from before this feature', async () => {
    draft.uploaded_fingerprint = null;
    await expect(prepareLiveSend(draft.id)).rejects.toThrow('Upload it again');
    expect(mocks.remote).not.toHaveBeenCalled();
  });
});
