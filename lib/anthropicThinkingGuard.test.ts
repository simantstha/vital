import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Regression guard for a production bug class: Claude Sonnet 5 runs ADAPTIVE
 * thinking when the `thinking` parameter is omitted, and thinking tokens count
 * against `max_tokens`. A Sonnet/Opus 5-family call that leaves `thinking` out
 * can have its JSON (or its only text block) eaten by thinking — that is what
 * turned every proactive workout/sleep analysis into the "couldn't put together
 * a read" fallback. Every other Sonnet 5 call in the repo sets
 * `thinking: { type: 'disabled' }` explicitly (lib/claude.ts, lib/brain/coach.ts,
 * lib/nutrition/estimator.ts); this test makes that a rule instead of a habit.
 *
 * How it works: find each `messages.create(` / `messages.stream(` call in
 * lib/, app/ and scripts/ (tests, evals and node_modules excluded), take the
 * text up to the matching closing paren, and — when the call's model is a
 * Sonnet/Opus 5-family constant or literal — require a `thinking` key. Haiku 4.5
 * calls don't think by default and are exempt.
 *
 * Known limits (deliberate, to stay simple): the model is recognised
 * lexically, so a call whose model comes from an unresolvable expression (e.g.
 * `configuration.model`, a function parameter) is not classified; and the
 * lexer treats a `/.../` regex literal like division, so an unbalanced quote or
 * paren inside a regex literal that sits inside a call would confuse it (an
 * unbalanced call fails the scan loudly rather than passing silently).
 */

/** Builders in lib/proactiveModelCall.ts set `thinking: { type: 'disabled' }`; lib/proactiveModelCall.test.ts proves it. */
const THINKING_SETTING_BUILDERS = /\bbuild(?:Analysis|Nudge)Request\s*\(/;

const SONNET_5_IDENTIFIER = /\b(?:CLAUDE_SONNET_MODEL|DEFAULT_PROACTIVE_ANALYSIS_MODEL|proactiveAnalysisModel)\b/;
const SONNET_OR_OPUS_5_LITERAL = /['"`]claude-(?:sonnet|opus)-5\b[^'"`]*['"`]/;

/**
 * Blanks out comments and the text of string/template literals (keeping the
 * quotes, `${...}` code and every newline) so offsets line up with the source
 * but parens, quotes and words inside prose can't be mistaken for code.
 */
export function maskNonCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  type Frame = { kind: 'code'; depth: number } | { kind: 'template' };
  const stack: Frame[] = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];
    if (top.kind === 'template') {
      if (ch === '\\') { blank(i, i + 2); i += 2; continue; }
      if (ch === '`') { stack.pop(); i++; continue; }
      if (ch === '$' && next === '{') { stack.push({ kind: 'code', depth: 0 }); i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (ch === "'" || ch === '"') {
      // A quote that never closes on its line is JSX text or similar, not a string: stop at the newline.
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const close = source[j] === ch ? j : i;
      blank(i + 1, close);
      i = close + 1; continue;
    }
    if (ch === '`') { stack.push({ kind: 'template' }); i++; continue; }
    if (ch === '{') { top.depth++; i++; continue; }
    if (ch === '}') {
      if (top.depth === 0 && stack.length > 1) stack.pop();
      else top.depth--;
      i++; continue;
    }
    i++;
  }
  return out.join('');
}

export interface ModelCall {
  line: number;
  /** True when the call's model is a Sonnet/Opus 5-family constant, literal or same-file alias of one. */
  sonnet5Family: boolean;
  /** True when the call sets a `thinking` key or is built by a builder that does. */
  setsThinking: boolean;
}

/** Names bound in this file to a Sonnet/Opus 5-family model (e.g. `const MODEL = CLAUDE_SONNET_MODEL`). */
function sonnetAliases(source: string, masked: string): string[] {
  const aliases: string[] = [];
  for (const match of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]*)/g)) {
    const rhsStart = (match.index ?? 0) + match[0].length - match[2].length;
    const rhsMasked = masked.slice(rhsStart, rhsStart + match[2].length);
    const rhsRaw = source.slice(rhsStart, rhsStart + match[2].length);
    if (SONNET_5_IDENTIFIER.test(rhsMasked) || SONNET_OR_OPUS_5_LITERAL.test(rhsRaw)) aliases.push(match[1]);
  }
  return aliases;
}

export function findModelCalls(source: string): ModelCall[] {
  const masked = maskNonCode(source);
  const aliases = sonnetAliases(source, masked);
  const calls: ModelCall[] = [];
  for (const match of masked.matchAll(/\bmessages\s*\.\s*(?:create|stream)\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < masked.length; k++) {
      if (masked[k] === '(') depth++;
      else if (masked[k] === ')' && --depth === 0) { close = k; break; }
    }
    assert.notEqual(close, -1, `unbalanced parentheses in a messages call at line ${source.slice(0, open).split('\n').length}`);
    const code = masked.slice(open, close + 1);
    const raw = source.slice(open, close + 1);
    const aliasModel = aliases.some((name) => new RegExp(`\\bmodel\\s*:\\s*${name.replace(/\$/g, '\\$')}\\b`).test(code));
    const literalModel = /\bmodel\s*:\s*['"`]claude-(?:sonnet|opus)-5\b/.test(raw);
    calls.push({
      line: source.slice(0, open).split('\n').length,
      sonnet5Family: SONNET_5_IDENTIFIER.test(code) || literalModel || aliasModel,
      setsThinking: /\bthinking\b\s*[:,}]/.test(code) || THINKING_SETTING_BUILDERS.test(code),
    });
  }
  return calls;
}

const SCANNED_DIRECTORIES = ['lib', 'app', 'scripts'];
const SCANNED_EXTENSIONS = /\.(?:ts|tsx|mts|js|mjs)$/;
const EXCLUDED_FILE = /(?:\.test\.|\.eval\.|^eval-)/;
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.next', 'evals']);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(full));
    } else if (SCANNED_EXTENSIONS.test(entry.name) && !EXCLUDED_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every Sonnet/Opus 5-family messages.create/stream call sets thinking explicitly', () => {
  const violations: string[] = [];
  const sonnetCallFiles = new Set<string>();
  let calls = 0;
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(path.join(repoRoot, directory))) {
      const source = readFileSync(file, 'utf8');
      if (!/\bmessages\s*\.\s*(?:create|stream)\s*\(/.test(source)) continue;
      const relative = path.relative(repoRoot, file);
      for (const call of findModelCalls(source)) {
        calls++;
        if (!call.sonnet5Family) continue;
        sonnetCallFiles.add(relative);
        if (!call.setsThinking) violations.push(`${relative}:${call.line}`);
      }
    }
  }

  // Sanity: the scan must actually be seeing the calls it exists to police.
  assert.ok(calls >= 8, `expected to scan at least 8 messages calls, found ${calls}`);
  for (const expected of ['scripts/proactive-health-worker.ts', 'lib/claude.ts', 'lib/nutrition/estimator.ts']) {
    assert.ok(sonnetCallFiles.has(expected), `expected ${expected} to be recognised as a Sonnet 5-family call site`);
  }

  assert.deepEqual(
    violations,
    [],
    `These Sonnet/Opus 5-family calls omit \`thinking\`, so Sonnet 5 runs adaptive thinking and thinking tokens eat max_tokens. Add \`thinking: { type: 'disabled' }\` (see lib/proactiveModelCall.ts):\n${violations.join('\n')}`,
  );
});

// ─── The scanner itself ──────────────────────────────────────────────────────

const only = (source: string): ModelCall => {
  const calls = findModelCalls(source);
  assert.equal(calls.length, 1);
  return calls[0];
};

test('flags a Sonnet constant call with no thinking key', () => {
  const call = only(`await client.messages.create({ model: CLAUDE_SONNET_MODEL, max_tokens: 100, messages });`);
  assert.deepEqual({ s: call.sonnet5Family, t: call.setsThinking }, { s: true, t: false });
});

test('accepts a Sonnet constant call that sets thinking, including across lines and for stream', () => {
  const call = only(`const s = client.messages.stream({
    model: CLAUDE_SONNET_MODEL,
    max_tokens: 100,
    thinking: { type: 'disabled' },
    messages,
  });`);
  assert.deepEqual({ s: call.sonnet5Family, t: call.setsThinking }, { s: true, t: true });
});

test('recognises each Sonnet 5-family spelling', () => {
  for (const model of ['CLAUDE_SONNET_MODEL', 'proactiveAnalysisModel(process.env)', 'DEFAULT_PROACTIVE_ANALYSIS_MODEL', `'claude-sonnet-5'`, `"claude-opus-5"`, '`claude-sonnet-5-5`']) {
    assert.equal(only(`x.messages.create({ model: ${model}, max_tokens: 1 })`).sonnet5Family, true, model);
  }
});

test('resolves a same-file alias of a Sonnet constant', () => {
  const call = only(`const MODEL = CLAUDE_SONNET_MODEL;\nawait client.messages.create({ model: MODEL, max_tokens: 1 });`);
  assert.deepEqual({ s: call.sonnet5Family, t: call.setsThinking }, { s: true, t: false });
});

test('exempts Haiku 4.5 calls and older Sonnet models', () => {
  assert.equal(only(`x.messages.create({ model: CLAUDE_HAIKU_MODEL, max_tokens: 1 })`).sonnet5Family, false);
  assert.equal(only(`x.messages.create({ model: 'claude-haiku-4-5', max_tokens: 1 })`).sonnet5Family, false);
  assert.equal(only(`x.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1 })`).sonnet5Family, false);
});

test('a thinking mention in a comment or string does not count as setting it', () => {
  const call = only(`x.messages.create({
    model: CLAUDE_SONNET_MODEL,
    // thinking: { type: 'disabled' },
    system: "thinking: { type: 'disabled' }",
    messages,
  });`);
  assert.equal(call.setsThinking, false);
});

test('unbalanced parens and quotes inside prompt strings and templates do not end the call early', () => {
  const call = only('x.messages.create({\n  model: CLAUDE_SONNET_MODEL,\n  system: `Use ) and ( freely, it\'s ${helper(")")} fine`,\n  note: "a ) b ( c",\n  thinking: { type: \'disabled\' },\n});');
  assert.deepEqual({ s: call.sonnet5Family, t: call.setsThinking }, { s: true, t: true });
});

test('a call built by the thinking-disabling builders counts as setting thinking', () => {
  const call = only(`await anthropic.messages.create(buildAnalysisRequest(proactiveAnalysisModel(process.env), request));`);
  assert.deepEqual({ s: call.sonnet5Family, t: call.setsThinking }, { s: true, t: true });
});

test('finds every call in a file and reports its line', () => {
  const calls = findModelCalls(`const a = 1;\nx.messages.create({ model: CLAUDE_HAIKU_MODEL });\n\nx.messages.create({ model: CLAUDE_SONNET_MODEL });\n`);
  assert.deepEqual(calls.map((call) => [call.line, call.sonnet5Family]), [[2, false], [4, true]]);
});

test('an unbalanced call fails loudly instead of passing silently', () => {
  assert.throws(() => findModelCalls(`x.messages.create({ model: CLAUDE_SONNET_MODEL, `), /unbalanced/);
});
