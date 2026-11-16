import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { switchboard } from './switchboard.js';

/**
 * The agent's tools. Each one is a thin call to the switchboard, which holds
 * the data, the connections and the guardrails. Nothing sensitive lives here.
 */
export function commandCenterTools(threadId: string, jobId: string) {
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await switchboard.tool(name, { threadId, jobId, input });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  };

  const define = <S extends z.ZodRawShape>(name: string, description: string, shape: S) =>
    tool(name, description, shape, (args) => call(name, args as Record<string, unknown>));

  return createSdkMcpServer({
    name: 'cc',
    version: '0.1.0',
    tools: [
      define('connected_apps', 'List apps the owner connected through Settings, with connection status.', {}),
      define('connected_app_search', 'Find tools and their argument schemas in a connected app. Search before calling a tool; do not invent tool names or arguments.', {
        app: z.string().describe('App slug from connected_apps, such as gmail.'), query: z.string().max(1000),
      }),
      define('connected_app_call', 'Run a tool discovered with connected_app_search. Gmail profile, email search and message reads run directly; other actions use the owner’s approval guardrail. Include a plain description of exactly what will change and for whom.', {
        app: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()), summary: z.string().max(2000),
      }),
      define('recent_sends', 'List the most recent emails sent to the main list, with opens and clicks for each. Newest first.', {
        limit: z.number().int().min(1).max(40).optional().describe('How many sends to return. Default 8.'),
      }),
      define('send_report', 'Full results for one send: rates, where the clicks went (by listing), and the average of the six sends before it.', {
        campaign_id: z.string().describe('The campaign id from recent_sends.'),
      }),
      define('performance_summary', 'Averages over the last 12 sends, the best and weakest by clicks, and the most clicked listings.', {}),
      define('search_listings', 'Search homes currently on the listings page. Returns listing ids to use in save_draft.', {
        query: z.string().optional().describe('Words to match in the address, area or description, for example "Tacony" or "washer".'),
        max_rent: z.number().optional(),
        min_beds: z.number().optional(),
        new_only: z.boolean().optional().describe('Only homes first seen in the last 7 days.'),
        limit: z.number().int().min(1).max(60).optional(),
      }),
      define('list_drafts', 'List email drafts, newest first.', {}),
      define(
        'save_draft',
        'Write or revise an email draft in the command center. Give headline, intro and listing ids and the email is laid out for you with photos, prices and links. Pass draft_id to revise an existing draft.',
        {
          draft_id: z.string().optional().describe('Set to revise an existing draft instead of creating a new one.'),
          name: z.string().describe('Campaign name as it will appear in Zoho, in the form "YYYY-MM-DD Series Email N Theme".'),
          subject: z.string().max(200),
          subject_b: z.string().max(200).optional().describe('An alternative subject line for the owner to choose between.'),
          preheader: z.string().max(200).optional().describe('Preview text shown after the subject in the inbox.'),
          headline: z.string().optional(),
          intro: z.string().optional().describe('One or two short paragraphs. Separate paragraphs with a blank line.'),
          featured_listing_ids: z.array(z.string()).max(6).optional().describe('Homes shown large with a photo. Two to four works best.'),
          more_listing_ids: z.array(z.string()).max(8).optional().describe('Homes shown as a compact list under "Also available now".'),
          more_heading: z.string().optional(),
          closing: z.string().optional(),
          cta_label: z.string().optional(),
          cta_url: z.string().optional(),
          hero_image_url: z.string().optional().describe('A hosted image for the top of the email. Optional.'),
          send_on: z.string().optional().describe('Planned send date, YYYY-MM-DD.'),
          html: z.string().optional().describe('Full custom HTML. Only when the standard layout cannot do what is needed.'),
        },
      ),
      define('send_test', "Send a draft from your address to the owner's inbox so they can read it.", { draft_id: z.string() }),
      define('upload_draft', 'Save a draft into Zoho Campaigns as a draft campaign (never scheduled or sent).', { draft_id: z.string() }),
      define('send_campaign', 'Request immediate live delivery of an uploaded draft to its mailing list. Uses the Send campaigns live guardrail: disabled by default, approval per send, or automatic. Never retry an uncertain send; ask the owner to check the provider.', { draft_id: z.string() }),
      define('find_hard_bounces', 'Count the addresses that hard-bounced on one send, with reasons.', { campaign_id: z.string() }),
      define('remove_hard_bounces', 'Ask to remove the addresses that hard-bounced on one send from the mailing list.', { campaign_id: z.string() }),
      define('remember', 'Save a preference, decision or lesson for future threads. One point per call, written to stand on its own.', {
        title: z.string().max(160),
        body: z.string().max(4000),
      }),
      define('generate_image', 'Create an image for the top of an email. Not for pictures of real homes: those come from the listings.', {
        prompt: z.string(),
        aspect: z.enum(['wide', 'landscape', 'square', 'portrait']).optional(),
      }),
      define('rename_thread', 'Give this thread a short, specific title, and optionally the series it belongs to.', {
        title: z.string().max(80).optional(),
        series: z.string().max(60).optional(),
      }),
      define('settle_thread', 'Mark this thread settled. Use when the owner asks to settle, after saving anything worth remembering.', {}),
    ],
  });
}

/** How a tool call reads in the thread's step list. */
export function stepLabel(name: string, input: Record<string, any>): { label: string; detail?: string } {
  const short = name.replace(/^mcp__cc__/, '');
  switch (short) {
    case 'connected_apps': return { label: 'Checked connected apps' };
    case 'connected_app_search': return { label: `Looked up ${input.app} capabilities`, detail: input.query };
    case 'connected_app_call': return { label: `Used ${input.app}`, detail: input.summary };
    case 'recent_sends':
      return { label: `Looked at the last ${input.limit ?? 8} sends` };
    case 'send_report':
      return { label: 'Read the full report for a send' };
    case 'performance_summary':
      return { label: 'Compared the last 12 sends' };
    case 'search_listings': {
      const parts = [input.query, input.max_rent && `up to $${input.max_rent}`, input.min_beds != null && `${input.min_beds}+ beds`, input.new_only && 'new this week'].filter(Boolean);
      return { label: 'Searched current listings', detail: parts.join(', ') || undefined };
    }
    case 'list_drafts':
      return { label: 'Checked existing drafts' };
    case 'save_draft':
      return { label: input.draft_id ? 'Revised a draft' : 'Wrote a draft', detail: input.subject };
    case 'send_test':
      return { label: 'Sent a test to your inbox' };
    case 'upload_draft':
      return { label: 'Asked to upload a draft to Zoho Campaigns' };
    case 'send_campaign':
      return { label: 'Requested a live campaign send' };
    case 'find_hard_bounces':
      return { label: 'Counted hard bounces on a send' };
    case 'remove_hard_bounces':
      return { label: 'Asked to remove hard bounces from the list' };
    case 'remember':
      return { label: 'Saved to memory', detail: input.title };
    case 'generate_image':
      return { label: 'Created an image', detail: String(input.prompt ?? '').slice(0, 120) };
    case 'rename_thread':
      return { label: 'Renamed the thread', detail: input.title };
    case 'settle_thread':
      return { label: 'Settled the thread' };
    case 'WebFetch':
      return { label: 'Read a web page', detail: input.url };
    case 'WebSearch':
      return { label: 'Searched the web', detail: input.query };
    default:
      return { label: short };
  }
}
