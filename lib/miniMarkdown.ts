/**
 * Tiny, dependency-free Markdown -> HTML renderer for the public legal pages
 * (docs/privacy-policy.md served at /privacy).
 *
 * Supported subset (everything the policy uses, nothing more):
 *   - ATX headings (# .. ######), with slug ids for deep links
 *   - paragraphs (hard-wrapped lines are joined with a space)
 *   - blockquotes (>), unordered (- * +) and ordered (1.) flat lists
 *   - pipe tables with a header row, horizontal rules (---)
 *   - inline: **bold**, *italic*, `code`, [text](url)
 *
 * Safety: every piece of source text is HTML-escaped before it is emitted, so
 * raw HTML in the Markdown can never reach the page as markup. Link targets are
 * restricted to http(s), mailto and same-site paths/anchors; anything else
 * (e.g. `javascript:`) is dropped and only the link text is rendered. The
 * output is therefore safe to inject with dangerouslySetInnerHTML.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Returns the URL if it is safe to put in an href, otherwise null. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  // Same-site path or in-page anchor. `//host` is protocol-relative, so reject it.
  if (/^\/(?!\/)/.test(url) || url.startsWith('#')) return url;
  return null;
}

const INLINE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function renderInline(source: string): string {
  let out = '';
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    out += escapeHtml(source.slice(last, match.index));
    last = match.index + match[0].length;
    const [, code, bold, italic, linkText, linkUrl] = match;
    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (bold !== undefined) {
      out += `<strong>${renderInline(bold)}</strong>`;
    } else if (italic !== undefined) {
      out += `<em>${renderInline(italic)}</em>`;
    } else {
      const href = safeHref(linkUrl);
      out += href
        ? `<a href="${escapeHtml(href)}">${renderInline(linkText)}</a>`
        : renderInline(linkText);
    }
  }
  return out + escapeHtml(source.slice(last));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    HEADING.test(line) ||
    line.trimStart().startsWith('>') ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
  );
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const slugCounts = new Map<string, number>();
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const base = slugify(heading[2]) || 'section';
      const seen = slugCounts.get(base) ?? 0;
      slugCounts.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        quoted.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    const listPattern = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
    if (listPattern) {
      const tag = listPattern === BULLET ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const item = listPattern.exec(lines[i]);
        if (item) {
          items.push(item[1].trim());
        } else if (/^\s+\S/.test(lines[i]) && items.length > 0) {
          // Indented continuation line of the previous item.
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else {
          break;
        }
        i++;
      }
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && (paragraph.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) {
      paragraph.push(lines[i].trim());
      i++;
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return html.join('\n');
}
