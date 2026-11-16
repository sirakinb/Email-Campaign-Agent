import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchboard } from './switchboard.js';
import { systemPrompt, withHistory, type JobContext } from './prompt.js';
import { commandCenterTools, stepLabel } from './tools.js';

/**
 * The agent process. It runs on the agent's computer, asks the switchboard for
 * work, runs one Claude Agent SDK session per thread, and streams what it
 * does back. Configure Claude authentication on this machine.
 */
const MODEL = process.env.AGENT_MODEL || 'claude-opus-5-5';
const MAX_PARALLEL = Number(process.env.AGENT_MAX_PARALLEL || 3);
const WORKDIR = process.env.AGENT_WORKDIR || path.join(os.homedir(), 'ea-workspace');
fs.mkdirSync(WORKDIR, { recursive: true });

const WEB_TOOLS = process.env.DEMO_MODE === 'true' ? [] : ['WebFetch', 'WebSearch'];

async function runJob(job: JobContext, resume: boolean): Promise<void> {
  const { id: jobId } = job.job;
  if (process.env.DEMO_MODE === 'true' && !job.context.demoMode) {
    await switchboard.event(jobId, { type: 'error', text: 'Demo worker refused a non-demo workspace.' });
    return;
  }
  const abort = new AbortController();
  let cancelled = false;
  const watcher = setInterval(async () => {
    if ((await switchboard.status(jobId).catch(() => 'unknown')) === 'cancelled') {
      cancelled = true;
      abort.abort();
    }
  }, 3000);

  // Streamed text is sent in small batches so the browser updates smoothly without a request per token.
  let pending = '';
  const flush = async () => {
    if (!pending) return;
    const text = pending;
    pending = '';
    await switchboard.event(jobId, { type: 'delta', text });
  };
  const flusher = setInterval(() => void flush(), 150);

  let finalText = '';
  let streamed = false;
  let lastAssistantText = '';
  try {
    const session = query({
      prompt: resume || !job.context.history.length ? job.job.prompt : withHistory(job),
      options: {
        model: MODEL,
        cwd: WORKDIR,
        systemPrompt: systemPrompt(job),
        ...(resume && job.thread.sessionId ? { resume: job.thread.sessionId } : {}),
        mcpServers: { cc: commandCenterTools(job.thread.id, jobId) },
        // Only the command center tools and read-only web access. No shell, no file edits.
        tools: WEB_TOOLS,
        allowedTools: ['mcp__cc', ...WEB_TOOLS],
        permissionMode: 'dontAsk',
        settingSources: [],
        // Without these the session also loads every connector on the owner's Claude account,
        // hundreds of unrelated tools that overflow the context after the first step.
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        includePartialMessages: true,
        maxTurns: 40,
        abortController: abort,
      },
    });

    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init') {
        await switchboard.event(jobId, { type: 'session', sessionId: message.session_id });
      } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const event = message.event;
        // A new turn begins after tool calls: separate its text from what came before.
        if (event.type === 'message_start' && streamed) pending += '\n\n';
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          pending += event.delta.text;
          streamed = true;
        }
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        const text = message.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        if (text.trim()) lastAssistantText = text;
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            const { label, detail } = stepLabel(block.name, (block.input ?? {}) as Record<string, unknown>);
            await switchboard.event(jobId, { type: 'step', label, detail });
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') finalText = message.result;
        else throw new Error(message.subtype === 'error_max_turns' ? 'The agent ran out of steps before finishing.' : `The run ended early (${message.subtype}).`);
      }
    }

    await flush();
    await switchboard.event(jobId, { type: 'final', text: finalText || lastAssistantText });
  } catch (error) {
    await flush();
    if (cancelled) return;
    const message = (error as Error).message ?? String(error);
    // The saved session can be missing, for example after moving to a new machine. Start again with the thread's history.
    if (resume && job.thread.sessionId && /no conversation found|session.*not found|ENOENT/i.test(message)) {
      clearInterval(watcher);
      clearInterval(flusher);
      return runJob(job, false);
    }
    await switchboard.event(jobId, { type: 'error', text: friendly(message) });
  } finally {
    clearInterval(watcher);
    clearInterval(flusher);
  }
}

function friendly(message: string): string {
  if (/invalid api key|not logged in|authentication|oauth|401/i.test(message)) {
    return 'Claude authentication failed on the agent computer. Check its ANTHROPIC_API_KEY or supported Claude authentication, restart the worker, then try again.';
  }
  if (/rate limit|overloaded|429|529|usage limit/i.test(message)) {
    return 'Claude is at its usage limit or busy right now. Try again in a little while.';
  }
  return message.slice(0, 400);
}

async function main() {
  console.log(`Agent starting. Switchboard: ${switchboard.base}. Model: ${MODEL}.`);
  for (;;) {
    try {
      await switchboard.hello();
      break;
    } catch (error) {
      console.error((error as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log('Connected. Waiting for work.');

  const active = new Set<Promise<void>>();
  for (;;) {
    if (active.size >= MAX_PARALLEL) {
      await Promise.race(active);
      continue;
    }
    try {
      const job = await switchboard.next();
      if (!job) continue;
      console.log(`Job ${job.job.id} in "${job.thread.title}" (${job.job.channel})`);
      const run = runJob(job, true).finally(() => active.delete(run));
      active.add(run);
    } catch (error) {
      console.error('Could not reach the switchboard:', (error as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

void main();
