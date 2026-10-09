import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { escapeHtml, renderMarkdown } from './miniMarkdown';

test('escapes raw HTML in paragraphs, headings, lists, tables and inline spans', () => {
  const html = renderMarkdown(
    [
      '# <script>alert(1)</script>',
      '',
      'Hello <img src=x onerror=alert(1)> & **<b>bold</b>** `<i>`',
      '',
      '- <svg onload=alert(1)>',
      '',
      '| a | b |',
      '| --- | --- |',
      '| <u>x</u> | y |',
    ].join('\n'),
  );
  assert.ok(!/<script|<img|<svg|<b>|<i>|<u>/.test(html), html);
  assert.match(html, /<h1 id="[^"]*">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; <strong>&lt;b&gt;bold&lt;\/b&gt;<\/strong> <code>&lt;i&gt;<\/code>/);
  assert.match(html, /<li>&lt;svg onload=alert\(1\)&gt;<\/li>/);
  assert.match(html, /<td>&lt;u&gt;x&lt;\/u&gt;<\/td>/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('only allows http(s), mailto, and same-site link targets', () => {
  const html = renderMarkdown(
    '[ok](https://example.com/a?b=1&c=2) [mail](mailto:a@b.co) [path](/privacy) [anchor](#top) ' +
      '[js](javascript:alert) [data](data:text/html,x) [proto](//evil.example) [q](https://x.co/"onmouseover="y)',
  );
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">ok<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.co">mail<\/a>/);
  assert.match(html, /<a href="\/privacy">path<\/a>/);
  assert.match(html, /<a href="#top">anchor<\/a>/);
  assert.ok(!/javascript:|data:text|\/\/evil/.test(html), html);
  assert.match(html, /js data proto/);
  // A quote in the URL must not break out of the href attribute.
  assert.ok(!/href="[^"]*"onmouseover/.test(html), html);
});

test('renders headings 1-3 with slug ids and de-duplicates repeated ids', () => {
  const html = renderMarkdown('# Vital Privacy Policy\n\n## What we collect\n\n### Details\n\n## What we collect');
  assert.match(html, /<h1 id="vital-privacy-policy">Vital Privacy Policy<\/h1>/);
  assert.match(html, /<h2 id="what-we-collect">What we collect<\/h2>/);
  assert.match(html, /<h3 id="details">Details<\/h3>/);
  assert.match(html, /<h2 id="what-we-collect-2">What we collect<\/h2>/);
});

test('renders unordered and ordered lists, including wrapped items', () => {
  const html = renderMarkdown('- one\n- two **bold**\n  continues here\n\n1. first\n2. second');
  assert.equal(
    html,
    '<ul><li>one</li><li>two <strong>bold</strong> continues here</li></ul>\n<ol><li>first</li><li>second</li></ol>',
  );
});

test('joins hard-wrapped lines into one paragraph and splits on blank lines', () => {
  const html = renderMarkdown('Line one\nline two.\n\nSecond paragraph.');
  assert.equal(html, '<p>Line one line two.</p>\n<p>Second paragraph.</p>');
});

test('renders blockquotes, tables, rules and leaves bracketed placeholders as text', () => {
  const html = renderMarkdown(
    '> **DRAFT** note\n> more\n\n**Effective date:** [DATE]\n\n---\n\n| Provider | Purpose |\n| --- | --- |\n| **Anthropic** | AI |',
  );
  assert.match(html, /<blockquote><p><strong>DRAFT<\/strong> note more<\/p><\/blockquote>/);
  assert.match(html, /<p><strong>Effective date:<\/strong> \[DATE\]<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(
    html,
    /<table><thead><tr><th>Provider<\/th><th>Purpose<\/th><\/tr><\/thead><tbody><tr><td><strong>Anthropic<\/strong><\/td><td>AI<\/td><\/tr><\/tbody><\/table>/,
  );
});

test('renders the real privacy policy: title, effective date, sections, table, no raw markup leaks', () => {
  const source = readFileSync(new URL('../docs/privacy-policy.md', import.meta.url), 'utf8');
  const html = renderMarkdown(source);
  assert.match(html, /<h1 id="vital-privacy-policy">Vital Privacy Policy<\/h1>/);
  assert.match(html, /<p><strong>Effective date:<\/strong> /);
  for (const section of ['What we collect', 'Who processes your data', 'Retention and deletion', 'Your choices and rights']) {
    assert.ok(html.includes(`>${section}</h2>`), `missing section: ${section}`);
  }
  assert.match(html, /<table>/);
  // Unconverted Markdown syntax would show up to readers as literal characters.
  assert.ok(!html.includes('**'), 'unrendered bold markers');
  assert.ok(!/<p>#{1,6} /.test(html), 'unrendered heading markers');
  assert.ok(!/<p>\s*\|/.test(html), 'unrendered table rows');
  assert.ok(!html.includes('vital.app'), 'stale placeholder URL');
});
