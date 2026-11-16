const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export { escapeHtml };

/** Small Markdown subset to HTML, for agent replies sent by email. */
export function markdownToHtml(markdown: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const blocks = markdown.trim().split(/\n{2,}/);
  const html = blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(block);
    if (heading && lines.length === 1) return `<p><strong>${inline(heading[2]!)}</strong></p>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  });
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">${html.join('')}</div>`;
}

/** Plain text for iMessage: drops Markdown markers that would show as symbols. */
export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .trim();
}

/** "2026-11-06 Fall 2026 Email 9 North Philly Combined" -> its parts. */
export function parseCampaignName(name: string): { sendDate: string | null; series: string | null; emailNumber: number | null; theme: string | null } {
  const dated = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(name.trim());
  const rest = dated ? dated[2]! : name.trim();
  const numbered = /^(.*?)\s*[-–]?\s*Email\s+(\d+)\s*[-–:]?\s*(.*)$/i.exec(rest);
  if (numbered) {
    return {
      sendDate: dated?.[1] ?? null,
      series: numbered[1]!.trim() || null,
      emailNumber: Number(numbered[2]),
      theme: numbered[3]!.trim() || null,
    };
  }
  return { sendDate: dated?.[1] ?? null, series: null, emailNumber: null, theme: dated ? rest : null };
}
