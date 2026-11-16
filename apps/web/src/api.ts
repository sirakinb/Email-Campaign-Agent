import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.status === 401 && path !== '/login') window.dispatchEvent(new Event('signed-out'));
  if (!response.ok) throw new ApiError(data.error ?? 'Something went wrong.', response.status);
  return data as T;
}

// --- Live updates: one stream for the whole app --------------------------------

export type LiveEvent = { type: string; threadId?: string | null; jobId?: string; text?: string; status?: string };
type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as LiveEvent;
      // After a reconnect anything may have changed, so everyone refreshes.
      for (const listener of listeners) listener(event);
    } catch {
      /* ignore malformed frames */
    }
  };
}

export function onLive(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

/**
 * Loads data and keeps it fresh: refetches when a live event of one of the
 * given types arrives (and, when `threadId` is set, only for that thread).
 */
export function useData<T>(path: string | null, refreshOn: string[] = [], threadId?: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const result = await api<T>(path);
      if (current.current === path) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const key = refreshOn.join(',');
  useEffect(() => {
    if (!key) return;
    const types = new Set(key.split(','));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onLive((event) => {
      if (event.type !== 'hello' && !types.has(event.type)) return;
      if (threadId && event.threadId && event.threadId !== threadId) return;
      // Bursts of events (a run of steps) collapse into one refetch.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 120);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [key, threadId, load]);

  return { data, error, reload: load, setData };
}

// --- Shapes ----------------------------------------------------------------------

export type Channel = 'chat' | 'text' | 'email' | 'automation';

export type ThreadSummary = {
  id: string;
  title: string;
  status: 'open' | 'settled';
  series: string | null;
  created_via: Channel;
  last_message_at: string;
  working: boolean;
  pending_approvals: number;
  preview: string | null;
  last_channel: Channel | null;
};

export type Message = { id: string; role: 'user' | 'agent' | 'system'; channel: Channel; body: string; meta: Record<string, unknown>; created_at: string };
export type Step = { id: string; job_id: string | null; label: string; detail: string | null; status: string; created_at: string };
export type Approval = {
  payload?: { app?: string; tool?: string; arguments?: Record<string, unknown> };
  id: string;
  action: string;
  title: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'done' | 'failed';
  result?: { error?: string } | null;
  decided_via?: string | null;
  created_at: string;
  decided_at?: string | null;
  thread_id?: string | null;
  thread_title?: string | null;
};
export type Draft = {
  id: string;
  name: string;
  subject: string;
  subject_b: string | null;
  preheader: string | null;
  send_on: string | null;
  status: 'draft' | 'tested' | 'uploaded';
  zoho_campaign_id: string | null;
  thread_id?: string | null;
  updated_at: string;
  zoho_status?: string | null;
};
export type ThreadDetail = {
  thread: ThreadSummary & { settled_at: string | null };
  messages: Message[];
  steps: Step[];
  approvals: Approval[];
  drafts: Draft[];
  jobs: { id: string; status: string; created_at: string }[];
};

export type Send = {
  id: string;
  name: string;
  status: string;
  subject: string | null;
  send_date: string | null;
  series: string | null;
  email_number: number | null;
  theme: string | null;
  sent: number;
  opens: number;
  opens_reliable: number | null;
  clicks: number;
  hard_bounced: number;
  soft_bounced: number;
  optout: number;
  detailed: boolean;
  open_rate: number | null;
  reliable_open_rate: number | null;
  click_rate: number | null;
  click_to_open_rate: number | null;
};
export type Averages = { sends: number; sent: number; open_rate: number | null; reliable_open_rate: number | null; click_rate: number | null; click_to_open_rate: number | null };

export type ComputerStatus = {
  configured: boolean;
  state: 'off' | 'asleep' | 'starting' | 'on' | 'error' | 'unknown';
  name?: string;
  size?: string;
  agentOnline: boolean;
  lastSeenAt: string | null;
  cooldownUntil?: string | null;
  error?: string;
};

export type Bootstrap = {
  demoMode?: boolean;
  agent: { name: string; enabled: boolean };
  brand: { name: string; product: string; accent: string };
  defaults: { sender_email: string; sender_name: string; list_id: string; list_name: string; topic_id: string; topic_name: string; listings_url: string };
  computer: ComputerStatus;
  pendingApprovals: number;
  channels: { email: string | null; text: boolean };
};

// --- Formatting ------------------------------------------------------------------

export const pct = (value: number | null | undefined, digits = 2) => (value == null ? '–' : `${value.toFixed(digits)}%`);
export const int = (value: number | null | undefined) => (value == null ? '–' : value.toLocaleString('en-US'));

export function shortDate(value: string | null | undefined, withYear = false): string {
  if (!value) return '–';
  // Plain dates are shown as written, not shifted by the viewer's timezone.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

export function clock(value: string): string {
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function ago(value: string | null | undefined): string {
  if (!value) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} d ago`;
  return shortDate(value);
}

export function until(value: string | null | undefined): string {
  if (!value) return 'not scheduled';
  const date = new Date(value);
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = clock(value);
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `tomorrow, ${time}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

export const CHANNEL_LABEL: Record<Channel, string> = { chat: 'Chat', text: 'Text', email: 'Email', automation: 'Scheduled' };
