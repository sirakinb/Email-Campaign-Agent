import { EventEmitter } from 'node:events';

/**
 * Everything the browser needs to hear about, pushed over one server-sent
 * events stream. Payloads are small pointers; the browser refetches what changed.
 */
export type BusEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'threads' }
  | { type: 'message'; threadId: string; messageId: string }
  | { type: 'delta'; threadId: string; jobId: string; text: string }
  | { type: 'step'; threadId: string }
  | { type: 'job'; threadId: string; jobId: string; status: string }
  | { type: 'approval'; approvalId: string; threadId: string | null }
  | { type: 'draft'; draftId: string; threadId: string | null }
  | { type: 'computer' }
  | { type: 'sync' };

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export const publish = (event: BusEvent) => emitter.emit('event', event);

export function subscribe(listener: (event: BusEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
