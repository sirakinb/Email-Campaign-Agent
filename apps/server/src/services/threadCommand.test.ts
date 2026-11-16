import { expect, it } from 'vitest';
import { newThreadBody } from './threadCommand.js';

it.each([
  ['Can you create a new thread and give me your opinion of what we can do to improve for the next campaign?', 'give me your opinion of what we can do to improve for the next campaign?'],
  ['New thread: December campaign', 'December campaign'],
  ['Start a new thread — Plan next week', 'Plan next week'],
  ['Could you please open a new thread and compare results?', 'compare results?'],
  ['Please create a new thread', ''],
  ["Let's start a new thread: Demo", 'Demo'],
])('recognizes %s', (message, body) => expect(newThreadBody(message)).toBe(body));

it.each([
  'Do not create a new thread', 'Can you explain how to create a new thread?',
  'We could start a new thread later', 'New threading system',
  'Review the latest campaign', '"Create a new thread" is a command',
])('does not mistake discussion for a command: %s', (message) => expect(newThreadBody(message)).toBeNull());
