import { describe, expect, it } from 'vitest';
import { campaignForSending, validateLiveSendTool } from './zoho.js';

const draft = {
  status: 'draft', subject: 'Homes available', sender_email: 'owner@example.com',
  recipient: { list_info_array: [{ list_id: '123456789012345678', list_name: 'Leads' }] },
  topic_id: '987654321098765432', updated_at: '2026-11-01T12:00:00Z',
};
const tool = { name: 'ZohoCampaigns_sendCampaign', inputSchema: {
  type: 'object', required: ['path_variables'], properties: {
    path_variables: { type: 'object', required: ['campaign_id'], properties: { campaign_id: { type: 'string' } } },
  },
} };

describe('live sending connector contract', () => {
  it('keeps long provider IDs as strings and retains the provider revision', () => {
    expect(campaignForSending(draft)).toEqual({ subject: draft.subject, sender_email: draft.sender_email,
      list_ids: ['123456789012345678'], topic_id: draft.topic_id, revision: draft });
  });
  it('refuses already-sent, queued, scheduled, and unknown provider states', () => {
    for (const status of ['sent', 'scheduled', 'inprogress', 'queued', undefined]) {
      expect(() => campaignForSending({ ...draft, status })).toThrow('draft status');
    }
  });
  it('refuses responses without verifiable recipients or a revision', () => {
    expect(() => campaignForSending({ ...draft, recipient: {} })).toThrow('recipient');
    expect(() => campaignForSending({ ...draft, topic_id: 123 })).toThrow('recipient');
    expect(() => campaignForSending({ ...draft, updated_at: undefined })).toThrow('revision');
  });
  it('accepts the explicitly supported campaign-ID send signature', () => {
    expect(() => validateLiveSendTool(tool)).not.toThrow();
  });
  it('rejects missing or incompatible send tools rather than guessing arguments', () => {
    expect(() => validateLiveSendTool(undefined)).toThrow('supported');
    expect(() => validateLiveSendTool({ ...tool, name: 'ZohoCampaigns_scheduleCampaign' })).toThrow('supported');
    expect(() => validateLiveSendTool({ ...tool, inputSchema: { ...tool.inputSchema, required: ['path_variables', 'body'] } })).toThrow('supported');
  });
});
