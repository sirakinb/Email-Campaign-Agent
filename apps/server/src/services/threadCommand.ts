/** Explicit thread commands at the start of an incoming text or email. */
const COMMAND = /^\s*(?:(?:can|could|would|will)\s+you\s+|(?:i['’]d like (?:you )?to|i want (?:you )?to|let['’]s)\s+)?(?:please\s+)?(?:(?:start|create|open)\s+(?:a\s+)?new thread\b|new thread\b)\s*(?:please\s*)?(?:[?:.\-–—]\s*)?(?:and\s+)?/i;

export function newThreadBody(message: string): string | null {
  const match = COMMAND.exec(message);
  return match ? message.slice(match[0].length).trim() : null;
}
