import { describe, expect, it } from 'vitest';
import { uploadedImageUrl } from './composio.js';

const url = 'https://res.cloudinary.com/example/image/upload/penny.jpg';
const result = (data: Record<string, unknown>, resultType = 'completed') => ({ data, resultType, logId: 'log_test' });

describe('Cloudinary upload responses', () => {
  it('accepts a provider response returned directly by a session', () => {
    expect(uploadedImageUrl(result({ secure_url: url }))).toBe(url);
  });
  it('accepts a wrapped JSON response', () => {
    expect(uploadedImageUrl(result({ data: JSON.stringify({ secure_url: url }), successful: true }))).toBe(url);
  });
  it('rejects failed and blocked executions even when an old URL is present', () => {
    for (const state of ['failed', 'blocked']) {
      expect(() => uploadedImageUrl(result({ secure_url: url }, state))).toThrow('log_test');
    }
  });
  it('rejects provider failures inside a completed execution', () => {
    expect(() => uploadedImageUrl(result({ successful: false, data: { secure_url: url } }))).toThrow('log_test');
  });
  it('does not treat an async batch receipt as a hosted image', () => {
    expect(() => uploadedImageUrl(result({ batch_id: 'queued' }))).toThrow('hosted HTTPS image');
  });
  it('rejects insecure and malformed payloads', () => {
    for (const data of [{ secure_url: 'http://example.com/image.jpg' }, { data: 'not JSON' }]) {
      expect(() => uploadedImageUrl(result(data))).toThrow('hosted HTTPS image');
    }
  });
});
