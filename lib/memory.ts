import fs from 'fs';
import path from 'path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { DATA_DIR } from './dataDir';

const MEMORY_ROOT = path.join(DATA_DIR, '.vital-memory');

const ALLOWED_FILES = [
  'memory-index.md',
  'core-profile.md',
  'coach-observations.md',
  'health-conditions.json',
  'training-history.json',
  'nutrition-habits.json',
  'life-context.json',
  'lab-results.json',
  'user-profile.md',
] as const;

type MemoryFile = typeof ALLOWED_FILES[number];

// ── Per-user directory + seeding ───────────────────────────────────────────

/** Absolute path to a given user's memory directory: <DATA_DIR>/.vital-memory/<userId>/ */
export function getUserMemoryDir(userId: string): string {
  return path.join(MEMORY_ROOT, userId);
}

/**
 * Resolves the fresh-install template directory to seed new users from.
 * Priority: explicit env override → the Docker-baked `/seed/.vital-memory`
 * path (see Dockerfile + scripts/docker-entrypoint.sh) → the tracked
 * `vital-memory-template/` dir at the repo root (local dev).
 */
function resolveTemplateDir(): string {
  const configured = process.env.VITAL_MEMORY_TEMPLATE_DIR;
  if (configured) return path.resolve(configured);

  const dockerSeed = '/seed/.vital-memory';
  if (fs.existsSync(dockerSeed)) return dockerSeed;

  return path.join(process.cwd(), 'vital-memory-template');
}

/**
 * Seeds a brand-new user's memory directory by copying the template dir,
 * recursively, only if the user's directory doesn't already exist. Safe to
 * call on every access — the existsSync check makes it a no-op after the
 * first call.
 */
export function seedUserMemory(userId: string): void {
  const dir = getUserMemoryDir(userId);
  if (fs.existsSync(dir)) return;

  try {
    const template = resolveTemplateDir();
    fs.mkdirSync(MEMORY_ROOT, { recursive: true });
    fs.cpSync(template, dir, { recursive: true });
  } catch {
    // Read-only fs, or template missing — fall back to an empty dir so
    // subsequent reads/writes still have somewhere to land.
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* still read-only */ }
  }
}

function memoryPath(userId: string, filename: MemoryFile): string {
  return path.join(getUserMemoryDir(userId), filename);
}

export function readMemoryFile(userId: string, filename: string): string | null {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return null;
  seedUserMemory(userId);
  try {
    return fs.readFileSync(memoryPath(userId, filename as MemoryFile), 'utf-8');
  } catch {
    return null;
  }
}

export function writeMemoryFile(userId: string, filename: string, content: string): void {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return;
  seedUserMemory(userId);
  try {
    fs.mkdirSync(getUserMemoryDir(userId), { recursive: true });
    fs.writeFileSync(memoryPath(userId, filename as MemoryFile), content, 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

export function appendObservation(userId: string, note: string): void {
  const date = new Date().toISOString().split('T')[0];
  const entry = `- [${date}] ${note}`;
  const content = readMemoryFile(userId, 'coach-observations.md') ?? '# Coach Observations\n\n';
  const lines = content.split('\n').filter(l => l.startsWith('- ['));
  lines.unshift(entry);
  const updated = '# Coach Observations\n\n' + lines.slice(0, 30).join('\n') + '\n';
  writeMemoryFile(userId, 'coach-observations.md', updated);
}

export function readHrvBaseline(userId: string): number | null {
  const profile = readMemoryFile(userId, 'core-profile.md');
  if (!profile) return null;
  const match = /hrv baseline:\s*(\d+)\s*ms/i.exec(profile);
  return match ? parseInt(match[1], 10) : null;
}

export function loadAlwaysOnContext(userId: string): string {
  const index = readMemoryFile(userId, 'memory-index.md') ?? '';
  const core = readMemoryFile(userId, 'core-profile.md') ?? '';
  const conditions = readMemoryFile(userId, 'health-conditions.json') ?? '{}';
  const observations = readMemoryFile(userId, 'coach-observations.md') ?? '';
  const labs = readMemoryFile(userId, 'lab-results.json') ?? '{}';

  return [
    '## Memory Index\n' + index,
    '## Core Profile\n' + core,
    '## Health Conditions (SAFETY — always follow these)\n```json\n' + conditions + '\n```',
    '## Lab Results\n```json\n' + labs + '\n```',
    observations,
  ].join('\n\n---\n\n');
}

export const MEMORY_TOOLS: Tool[] = [
  {
    name: 'read_memory',
    description:
      'Read a memory file by name. Check memory-index.md first to know what each file contains, then fetch domain files only when relevant to the current message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          enum: [...ALLOWED_FILES],
          description: 'The memory file to read.',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'write_memory',
    description:
      'Overwrite a structured JSON memory file with updated content. Use when you learn a new fact (injury, food reaction, PR, allergy, supplement, stress event, travel, mood/energy score). Always read the file first, merge the new fact, then write the full updated JSON. For mood: add to life-context.json moodLog as { date, score (1-5), notes }.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          // Intentionally excludes memory-index.md (managed manually) and
          // coach-observations.md (use append_observation tool instead).
          enum: ['health-conditions.json', 'training-history.json', 'nutrition-habits.json', 'life-context.json', 'core-profile.md', 'lab-results.json', 'user-profile.md'],
          description: 'The memory file to overwrite.',
        },
        content: {
          type: 'string',
          description: 'Full updated file content (JSON string for .json files, markdown for .md).',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'append_observation',
    description:
      'Append a short, dated coaching insight to coach-observations.md. Use after noticing a pattern, trend, or anything worth remembering about this user that does not fit a structured field. Keep it under 20 words.',
    input_schema: {
      type: 'object' as const,
      properties: {
        note: {
          type: 'string',
          description: 'The observation to append (under 20 words).',
        },
      },
      required: ['note'],
    },
  },
] as const;

export function handleToolCall(userId: string, name: string, input: unknown): string {
  const inp = input as Record<string, string>;
  if (name === 'read_memory') {
    return readMemoryFile(userId, inp.filename) ?? `File "${inp.filename}" not found.`;
  }
  if (name === 'write_memory') {
    writeMemoryFile(userId, inp.filename, inp.content);
    return 'Memory updated.';
  }
  if (name === 'append_observation') {
    appendObservation(userId, inp.note);
    return 'Observation appended.';
  }
  return 'Unknown tool.';
}
