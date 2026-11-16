import crypto from 'node:crypto';
import { env } from '../env.js';
import { cloudinaryConnection, uploadWithComposio } from './composio.js';

const FAL_MODEL = process.env.FAL_MODEL || 'fal-ai/flux/dev';

const SIZES: Record<string, string> = {
  wide: 'landscape_16_9',
  banner: 'landscape_16_9',
  landscape: 'landscape_4_3',
  square: 'square_hd',
  portrait: 'portrait_4_3',
};

export const mediaReady = () => Boolean(env.falKey);
const nativeHostingReady = () => Boolean(env.cloudinaryKey && env.cloudinarySecret && env.cloudinaryCloud);
export const hostingReady = async () => nativeHostingReady() || (await cloudinaryConnection()).status === 'connected';

/** Generates an image with FAL, then moves it to Cloudinary so the address is stable in an email. */
export async function generateImage(input: { prompt: string; aspect?: string }): Promise<{ url: string; hosted: boolean; note?: string }> {
  if (!env.falKey) throw new Error('Image generation is not connected. Add the FAL key.');
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${env.falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.prompt, image_size: SIZES[input.aspect ?? 'wide'] ?? 'landscape_16_9', num_images: 1 }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`FAL returned ${response.status}: ${text.slice(0, 300)}`);
  const url = (JSON.parse(text) as { images?: { url: string }[] }).images?.[0]?.url;
  if (!url) throw new Error('FAL did not return an image.');

  if (!(await hostingReady())) {
    return { url, hosted: false, note: 'Cloudinary is not fully connected, so this is a temporary FAL address. Do not use it in an uploaded draft.' };
  }
  return { url: await uploadToCloudinary(url), hosted: true };
}

export async function uploadToCloudinary(sourceUrl: string, folder = 'email-agent'): Promise<string> {
  if (!nativeHostingReady()) return uploadWithComposio(sourceUrl, folder);
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `folder=${folder}&timestamp=${timestamp}${env.cloudinarySecret}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  const form = new URLSearchParams({ file: sourceUrl, folder, timestamp: String(timestamp), api_key: env.cloudinaryKey, signature });
  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudinaryCloud}/image/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cloudinary returned ${response.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { secure_url: string }).secure_url;
}
