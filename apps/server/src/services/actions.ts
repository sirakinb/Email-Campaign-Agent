import { json, sql } from '../db.js';
import { publish } from '../bus.js';
import { env } from '../env.js';
import { sendEmail } from './agentmail.js';
import { createDraftCampaign, getCampaignRevision, removeFromList, updateDraftCampaign } from './zoho.js';
import { generateImage } from './media.js';
import { executeAppTool } from './connectedApps.js';
import { renderEmail, type EmailListing } from './emailTemplate.js';
import { executeLiveSend, fingerprint, uploadFingerprint, type SendSnapshot } from './campaignSending.js';

export type ActionName =
  | 'plan'
  | 'write_draft'
  | 'send_test'
  | 'generate_media'
  | 'upload_draft'
  | 'list_hygiene'
  | 'save_memory'
  | 'send_live'
  | 'connected_app_action';

type Executor = (payload: Record<string, any>, threadId: string | null, context?: { approvalId: string }) => Promise<unknown>;

export type Defaults = {
  sender_email: string;
  sender_name: string;
  list_id: string;
  list_name: string;
  topic_id: string;
  topic_name: string;
  listings_url: string;
};

export async function getDefaults(): Promise<Defaults> {
  const [row] = await sql<{ value: Defaults }[]>`select value from settings where key = 'defaults'`;
  return row!.value;
}

export type DraftRow = {
  id: string;
  thread_id: string | null;
  name: string;
  subject: string;
  subject_b: string | null;
  preheader: string | null;
  html: string;
  listing_ids: string[];
  send_on: string | null;
  status: 'draft' | 'tested' | 'uploaded' | 'submitting' | 'submitted' | 'unknown';
  zoho_campaign_id: string | null;
  created_at: string;
  updated_at: string;
  send_locked: boolean;
};

async function getDraft(id: string): Promise<DraftRow> {
  const [draft] = await sql<DraftRow[]>`select * from drafts where id = ${id}`;
  if (!draft) throw new Error('That draft no longer exists.');
  return draft;
}

const htmlToText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/tr|\/h\d|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const executors: Record<ActionName, Executor> = {
  connected_app_action: async (payload) => executeAppTool(payload.app, payload.tool, payload.arguments),
  plan: async () => ({ ok: true }),

  /** Saves or revises a draft here in the command center. Nothing leaves the building. */
  write_draft: async (payload, threadId) => {
    const defaults = await getDefaults();
    let html: string = payload.html ?? '';
    const listingIds: string[] = [...(payload.featured_listing_ids ?? []), ...(payload.more_listing_ids ?? [])];

    if (!html) {
      const rows = listingIds.length ? await sql<EmailListing[]>`select * from listings where id in ${sql(listingIds)}` : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const pick = (ids: string[] = []) => ids.map((id) => byId.get(id)).filter((l): l is EmailListing => Boolean(l));
      const missing = listingIds.filter((id) => !byId.has(id));
      if (missing.length) throw new Error(`These listing ids are not in the current listings: ${missing.join(', ')}. Search listings again and use ids from the results.`);
      html = renderEmail({
        headline: payload.headline,
        intro: payload.intro,
        featured: pick(payload.featured_listing_ids),
        more: pick(payload.more_listing_ids),
        moreHeading: payload.more_heading,
        closing: payload.closing,
        ctaLabel: payload.cta_label,
        ctaUrl: payload.cta_url ?? defaults.listings_url,
        heroImageUrl: payload.hero_image_url,
        preheader: payload.preheader,
        senderName: defaults.sender_name,
      });
    }

    if (payload.draft_id) {
      const [updated] = await sql<DraftRow[]>`
        update drafts set
          name = ${payload.name}, subject = ${payload.subject}, subject_b = ${payload.subject_b ?? null},
          preheader = ${payload.preheader ?? null}, html = ${html}, listing_ids = ${json(listingIds)},
          send_on = ${payload.send_on ?? null}, status = case when status = 'uploaded' then 'uploaded' else 'draft' end,
          updated_at = now()
        where id = ${payload.draft_id} and not send_locked returning *`;
      if (!updated) throw new Error('This draft no longer exists or a live send was already attempted. Create a new draft instead.');
      publish({ type: 'draft', draftId: updated.id, threadId: updated.thread_id });
      return {
        draft_id: updated.id,
        revised: true,
        note: updated.zoho_campaign_id ? 'This draft was already uploaded to Zoho. Upload it again to update the copy there.' : undefined,
      };
    }

    const [created] = await sql<DraftRow[]>`
      insert into drafts (thread_id, name, subject, subject_b, preheader, html, listing_ids, send_on)
      values (${threadId}, ${payload.name}, ${payload.subject}, ${payload.subject_b ?? null}, ${payload.preheader ?? null},
              ${html}, ${json(listingIds)}, ${payload.send_on ?? null})
      returning *`;
    publish({ type: 'draft', draftId: created!.id, threadId });
    return { draft_id: created!.id, revised: false };
  },

  /** Sends the draft from the agent's address to the owner's inbox. Never to the mailing list. */
  send_test: async (payload) => {
    if (env.demoMode) {
      const draft = await getDraft(payload.draft_id);
      await sql`update drafts set status = case when status = 'draft' then 'tested' else status end where id = ${draft.id}`;
      publish({ type: 'draft', draftId: draft.id, threadId: draft.thread_id });
      return { simulated: true, note: 'Demo test preview approved. No email was sent. Read the draft in Email preview.' };
    }
    if (!env.ownerEmail) throw new Error('No owner email is set, so there is nowhere to send a test. Set OWNER_EMAIL.');
    const draft = await getDraft(payload.draft_id);
    const sent = await sendEmail({
      to: env.ownerEmail,
      subject: `[Test] ${draft.subject}`,
      html: draft.html,
      text: htmlToText(draft.html),
      labels: ['test-draft'],
      idempotencyKey: `test-${draft.id}-${new Date(draft.updated_at).getTime()}`,
    });
    await sql`update drafts set status = case when status = 'draft' then 'tested' else status end where id = ${draft.id}`;
    publish({ type: 'draft', draftId: draft.id, threadId: draft.thread_id });
    return { sent_to: env.ownerEmail, message_id: sent.message_id };
  },

  /** Uploading is separate from the optional live-send action. */
  upload_draft: async (payload) => {
    const draft = await getDraft(payload.draft_id);
    if (env.demoMode) {
      const id = draft.zoho_campaign_id ?? `demo-draft-${draft.id}`;
      await sql`update drafts set status = 'uploaded', zoho_campaign_id = ${id}, updated_at = now() where id = ${draft.id}`;
      publish({ type: 'draft', draftId: draft.id, threadId: draft.thread_id });
      return { simulated: true, demo_draft_id: id, note: 'SIMULATED: draft handoff recorded in the demo only. No live Zoho account was accessed and no email was sent.' };
    }
    const result = await sql.begin(async (tx) => {
      const [draft] = await tx<DraftRow[]>`select * from drafts where id = ${payload.draft_id} for update`;
      if (!draft || draft.send_locked) throw new Error('This draft is unavailable or a live send was already attempted. Create a new draft instead.');
      const defaults = await getDefaults();
      if (![defaults.sender_email, defaults.sender_name, defaults.list_id, defaults.topic_id].every((value) => value.trim())) {
        throw new Error('Complete the sender, mailing list ID and topic ID in Settings → Campaign setup before uploading.');
      }
      const upload = {
        name: draft.name,
        subject: draft.subject,
        preheader: draft.preheader,
        html: draft.html,
        senderEmail: defaults.sender_email,
        senderName: defaults.sender_name,
        listId: defaults.list_id,
        topicId: defaults.topic_id,
      };
      let campaignId = draft.zoho_campaign_id;
      if (campaignId) {
        await updateDraftCampaign(campaignId, upload);
      } else {
        campaignId = await createDraftCampaign(upload);
      }
      // Bind later live-send requests to the provider's copy at upload time.
      // An unavailable readback must not break the existing manual-send workflow.
      const providerHash = await getCampaignRevision(campaignId).then(fingerprint).catch(() => null);
      await tx`update drafts set status = 'uploaded', zoho_campaign_id = ${campaignId}, uploaded_fingerprint = ${uploadFingerprint(draft, defaults)},
        uploaded_provider_fingerprint = ${providerHash}, updated_at = now() where id = ${draft.id}`;
      return {
        zoho_campaign_id: campaignId,
        list: defaults.list_name,
        topic: defaults.topic_name,
        sender: defaults.sender_email,
        note: 'Saved in Zoho Campaigns as a draft. It has not been sent or scheduled. The owner can send manually, or request a separate live send if enabled in Settings.',
      };
    });
    publish({ type: 'draft', draftId: draft.id, threadId: draft.thread_id });
    return result;
  },

  /** Removes hard-bounced contacts from a Zoho Campaigns list. Zoho CRM is not touched. */
  list_hygiene: async (payload) => {
    if (env.demoMode) return { simulated: true, note: 'No real contacts were changed.' };
    const contactIds: string[] = payload.contact_ids ?? [];
    if (!contactIds.length) return { removed: 0 };
    const removed = await removeFromList(payload.list_id, contactIds);
    return { removed, list: payload.list_name ?? payload.list_id };
  },

  save_memory: async (payload, threadId) => {
    const [memory] = await sql<{ id: string }[]>`
      insert into memories (title, body, source_thread_id)
      values (${String(payload.title).slice(0, 160)}, ${String(payload.body).slice(0, 4000)}, ${threadId})
      returning id`;
    return { memory_id: memory!.id };
  },

  generate_media: async (payload) => env.demoMode ? { simulated: true, url: `${env.publicUrl}/demo-assets/demo-maple.svg`, note: 'Prebuilt fictional illustration, not a newly generated photograph.' } : generateImage({ prompt: payload.prompt, aspect: payload.aspect }),

  send_live: async (payload, _threadId, context) => executeLiveSend(payload as SendSnapshot, context?.approvalId),
};
