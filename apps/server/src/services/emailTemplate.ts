import { escapeHtml } from './text.js';

/**
 * Renders a marketing email from structured blocks so every draft is laid out
 * the same way and survives email clients: tables, inline styles, one column,
 * 600px wide. The agent supplies words and picks listings; this does layout.
 */
export type EmailListing = {
  id: string;
  url: string;
  address: string;
  city: string | null;
  neighborhood: string | null;
  rent_text: string | null;
  rent: number | null;
  beds: number | string | null;
  baths: number | string | null;
  sqft: number | null;
  photo_url: string | null;
  tour_url: string | null;
  available: string | null;
};

export type EmailBlocks = {
  headline: string;
  intro: string;
  /** Shown large, with photo. */
  featured: EmailListing[];
  /** Shown as a compact list under "Also available". */
  more: EmailListing[];
  moreHeading?: string;
  closing?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  heroImageUrl?: string | null;
  preheader?: string | null;
  senderName: string;
};

const INK = '#1c1b1f';
const MUTED = '#6b6772';
const LINE = '#e6e3ea';
const ACCENT = '#5b21b6';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const facts = (l: EmailListing): string => {
  const parts: string[] = [];
  if (l.beds != null) parts.push(Number(l.beds) === 0 ? 'Studio' : `${Number(l.beds)} bed`);
  if (l.baths != null) parts.push(`${Number(l.baths)} bath`);
  if (l.sqft) parts.push(`${l.sqft.toLocaleString('en-US')} sq ft`);
  return parts.join(' · ');
};

const rent = (l: EmailListing): string => l.rent_text ?? (l.rent != null ? `$${l.rent.toLocaleString('en-US')}` : '');

const paragraphs = (text: string, style: string): string =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="${style}">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

function featuredCard(l: EmailListing): string {
  const where = [l.neighborhood, l.city].filter(Boolean).join(', ');
  const photo = l.photo_url
    ? `<tr><td><a href="${escapeHtml(l.url)}"><img src="${escapeHtml(l.photo_url)}" width="552" alt="${escapeHtml(l.address)}" style="display:block;width:100%;max-width:552px;height:auto;border:0;border-radius:10px 10px 0 0"></a></td></tr>`
    : '';
  const tour = l.tour_url
    ? `<td style="padding-left:16px"><a href="${escapeHtml(l.tour_url)}" style="font:600 14px ${FONT};color:${ACCENT};text-decoration:underline">Take the virtual tour</a></td>`
    : '';
  return `
<tr><td style="padding:0 24px 20px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:10px">
    ${photo}
    <tr><td style="padding:18px 20px 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:600 18px/1.3 ${FONT};color:${INK}">${escapeHtml(l.address)}</td>
        <td align="right" style="font:600 18px/1.3 ${FONT};color:${INK};white-space:nowrap;padding-left:12px">${escapeHtml(rent(l))}</td>
      </tr></table>
      <p style="margin:6px 0 0;font:14px/1.5 ${FONT};color:${MUTED}">${escapeHtml([facts(l), where].filter(Boolean).join(' · '))}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>
        <td style="background:${INK};border-radius:8px"><a href="${escapeHtml(l.url)}" style="display:inline-block;padding:11px 18px;font:600 14px ${FONT};color:#ffffff;text-decoration:none">See photos and apply</a></td>
        ${tour}
      </tr></table>
    </td></tr>
  </table>
</td></tr>`;
}

function compactRow(l: EmailListing): string {
  return `
<tr>
  <td style="padding:12px 0;border-top:1px solid ${LINE}">
    <a href="${escapeHtml(l.url)}" style="font:600 15px/1.4 ${FONT};color:${INK};text-decoration:none">${escapeHtml(l.address)}</a>
    <div style="font:13px/1.5 ${FONT};color:${MUTED}">${escapeHtml([facts(l), l.neighborhood ?? l.city].filter(Boolean).join(' · '))}</div>
  </td>
  <td align="right" style="padding:12px 0;border-top:1px solid ${LINE};font:600 15px ${FONT};color:${INK};white-space:nowrap">${escapeHtml(rent(l))}</td>
</tr>`;
}

export function renderEmail(blocks: EmailBlocks): string {
  const cta = blocks.ctaUrl
    ? `<tr><td align="center" style="padding:8px 24px 28px">
        <a href="${escapeHtml(blocks.ctaUrl)}" style="display:inline-block;padding:12px 22px;border:1px solid ${INK};border-radius:8px;font:600 14px ${FONT};color:${INK};text-decoration:none">${escapeHtml(blocks.ctaLabel || 'See every available home')}</a>
      </td></tr>`
    : '';
  const more = blocks.more.length
    ? `<tr><td style="padding:4px 24px 20px">
        <p style="margin:0 0 4px;font:600 13px ${FONT};letter-spacing:.02em;color:${MUTED}">${escapeHtml(blocks.moreHeading || 'Also available now')}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${blocks.more.map(compactRow).join('')}</table>
      </td></tr>`
    : '';
  const hero = blocks.heroImageUrl
    ? `<tr><td><img src="${escapeHtml(blocks.heroImageUrl)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>`
    : '';
  const preheader = blocks.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(blocks.preheader)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(blocks.headline)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f2f7">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2f7">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
  <tr><td style="padding:22px 24px 0;font:600 13px ${FONT};letter-spacing:.02em;color:${MUTED}">${escapeHtml(blocks.senderName)}</td></tr>
  ${hero}
  <tr><td style="padding:14px 24px 6px">
    <h1 style="margin:0;font:700 26px/1.2 ${FONT};color:${INK}">${escapeHtml(blocks.headline)}</h1>
  </td></tr>
  <tr><td style="padding:6px 24px 14px">${paragraphs(blocks.intro, `margin:0 0 12px;font:16px/1.55 ${FONT};color:${INK}`)}</td></tr>
  ${blocks.featured.map(featuredCard).join('')}
  ${more}
  ${blocks.closing ? `<tr><td style="padding:0 24px 12px">${paragraphs(blocks.closing, `margin:0 0 12px;font:16px/1.55 ${FONT};color:${INK}`)}</td></tr>` : ''}
  ${cta}
  <tr><td style="padding:18px 24px 24px;border-top:1px solid ${LINE};font:12px/1.6 ${FONT};color:${MUTED}">
    You are receiving this because you asked ${escapeHtml(blocks.senderName)} about a rental home.<br>
    <a href="$[LI:SUB_PREF]$" style="color:${MUTED}">Email preferences</a> · <a href="$[LI:UNSUBSCRIBE]$" style="color:${MUTED}">Unsubscribe</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
