import crypto from 'node:crypto';
import { sql, json } from '../db.js';
import { env } from '../env.js';
import { publish } from '../bus.js';
import { getCampaignForSending, sendCampaignNow } from './zoho.js';
import type { Defaults, DraftRow } from './actions.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function uploadFingerprint(draft: Pick<DraftRow, 'name' | 'subject' | 'preheader' | 'html'>, defaults: Defaults): string {
  return fingerprint({ name: draft.name, subject: draft.subject, preheader: draft.preheader ?? null, html: draft.html,
    sender_email: defaults.sender_email, sender_name: defaults.sender_name, list_id: defaults.list_id, topic_id: defaults.topic_id });
}

type SendDraft = DraftRow & { uploaded_fingerprint: string | null; uploaded_provider_fingerprint: string | null; send_locked: boolean };
export type SendSnapshot = {
  draft_id: string;
  thread_id: string | null;
  campaign_id: string;
  local_fingerprint: string;
  remote_fingerprint: string;
  subject: string;
  sender: string;
  list_id: string;
  list_name: string;
  topic_id: string;
};

async function currentDraft(draftId: string) {
  const [draft] = await sql<SendDraft[]>`select * from drafts where id = ${draftId}`;
  if (!draft?.zoho_campaign_id) throw new Error('Upload this draft before requesting a live send.');
  if (draft.send_locked) throw new Error('A send was already attempted for this draft. Check Zoho; do not retry.');
  const [settings] = await sql<{ value: Defaults }[]>`select value from settings where key = 'defaults'`;
  const defaults = settings!.value;
  const hash = uploadFingerprint(draft, defaults);
  if (draft.uploaded_fingerprint !== hash) throw new Error('The draft or campaign settings changed, or this upload predates live sending. Upload it again, then request a new send.');
  return { draft, defaults, hash };
}

/** Build the approval from server-owned data, never from agent-supplied recipients. */
export async function prepareLiveSend(draftId: string): Promise<SendSnapshot> {
  if (env.demoMode) throw new Error('Live campaign sending is disabled in the demo.');
  const { draft, defaults, hash } = await currentDraft(draftId);
  const [attempt] = await sql`select status from campaign_send_attempts where campaign_id = ${draft.zoho_campaign_id!}`;
  if (attempt) throw new Error('A send was already attempted for this campaign. Check its status in Zoho; the agent will not resend it.');
  const remote = await getCampaignForSending(draft.zoho_campaign_id!);
  if (draft.uploaded_provider_fingerprint !== fingerprint(remote.revision)) {
    throw new Error('The provider copy changed since upload, or its uploaded revision could not be verified. Upload again and request a new send.');
  }
  if (remote.subject !== draft.subject || remote.sender_email !== defaults.sender_email ||
      remote.topic_id !== defaults.topic_id || remote.list_ids.length !== 1 || remote.list_ids[0] !== defaults.list_id) {
    throw new Error('The campaign in Zoho does not match the current subject, sender, list and topic. Check it and upload a new draft before sending.');
  }
  return { draft_id: draftId, thread_id: draft.thread_id ?? null, campaign_id: draft.zoho_campaign_id!, local_fingerprint: hash,
    remote_fingerprint: fingerprint(remote.revision), subject: draft.subject, sender: defaults.sender_email,
    list_id: defaults.list_id, list_name: defaults.list_name, topic_id: defaults.topic_id };
}

export async function executeLiveSend(snapshot: SendSnapshot, approvalId?: string) {
  if (env.demoMode) throw new Error('Live campaign sending is disabled in the demo.');
  const fresh = await prepareLiveSend(snapshot.draft_id);
  if (fingerprint(fresh) !== fingerprint(snapshot)) throw new Error('The campaign changed after this send was requested. Review it and request a new send.');

  // Commit the claim BEFORE contacting Zoho. Even a worker/server crash must
  // leave a durable record that prevents another request for the same campaign.
  await sql.begin(async (tx) => {
    const [guardrail] = await tx<{ level: string; locked: boolean }[]>`select level, locked from guardrails where action = 'send_live' for share`;
    if (!guardrail || guardrail.locked || guardrail.level === 'draft_only') throw new Error('Live campaign sending is turned off in Settings.');
    if (guardrail.level === 'approve_first') {
      const [approval] = await tx`select id from approvals where id = ${approvalId ?? null} and action = 'send_live' and status = 'approved' and payload = ${json(snapshot)}`;
      if (!approval) throw new Error('This live send needs a new owner approval.');
    }
    const [draft] = await tx<SendDraft[]>`select * from drafts where id = ${snapshot.draft_id} for update`;
    const [settings] = await tx<{ value: Defaults }[]>`select value from settings where key = 'defaults' for share`;
    if (!draft || draft.send_locked || draft.zoho_campaign_id !== snapshot.campaign_id || draft.uploaded_fingerprint !== snapshot.local_fingerprint ||
        draft.uploaded_provider_fingerprint !== snapshot.remote_fingerprint ||
        uploadFingerprint(draft, settings!.value) !== snapshot.local_fingerprint) throw new Error('The draft changed. Request a new send.');
    const claimed = await tx`insert into campaign_send_attempts (campaign_id, draft_id, status, snapshot)
      values (${snapshot.campaign_id}, ${snapshot.draft_id}, 'submitting', ${json(snapshot)})
      on conflict (campaign_id) do nothing returning campaign_id`;
    if (!claimed.length) throw new Error('A send was already attempted for this campaign. Check Zoho; do not retry.');
    await tx`update drafts set send_locked = true, status = 'submitting' where id = ${snapshot.draft_id}`;
  });
  publish({ type: 'draft', draftId: snapshot.draft_id, threadId: snapshot.thread_id });

  try {
    await sendCampaignNow(snapshot.campaign_id);
    await sql`update campaign_send_attempts set status = 'submitted', updated_at = now() where campaign_id = ${snapshot.campaign_id}`;
    await sql`update drafts set status = 'submitted' where id = ${snapshot.draft_id}`;
    publish({ type: 'draft', draftId: snapshot.draft_id, threadId: snapshot.thread_id });
    return { campaign_id: snapshot.campaign_id, status: 'submitted', note: 'The provider accepted the live send request. Delivery is not yet confirmed; check campaign results in Zoho.' };
  } catch (error) {
    await sql`update campaign_send_attempts set status = 'unknown', detail = ${String((error as Error).message).slice(0, 1000)}, updated_at = now() where campaign_id = ${snapshot.campaign_id}`;
    await sql`update drafts set status = 'unknown' where id = ${snapshot.draft_id}`;
    publish({ type: 'draft', draftId: snapshot.draft_id, threadId: snapshot.thread_id });
    throw new Error('The send outcome could not be confirmed. Do not retry: the provider may have accepted it. Check this campaign in Zoho before taking any further action.');
  }
}
