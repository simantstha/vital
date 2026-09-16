import fs from 'fs';
import path from 'path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { DATA_DIR } from './dataDir';
import { readStoredMemoryFile, writeStoredMemoryFile } from '@/lib/memoryFilesStore';

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

/**
 * Filenames whose canonical store is `users.memory_files` (see
 * lib/memoryFilesStore.ts) rather than raw disk. 'core-profile.md' is
 * deliberately excluded — it has its own dedicated `users.core_profile_md`
 * column and store (lib/coreProfileStore.ts), predating this one.
 * 'memory-index.md' is excluded too — it's managed manually, never written
 * by the coach (see MEMORY_TOOLS' write_memory enum below), and stays
 * disk-only.
 */
const POSTGRES_BACKED_FILES = [
  'health-conditions.json',
  'training-history.json',
  'nutrition-habits.json',
  'life-context.json',
  'lab-results.json',
  'coach-observations.md',
  'user-profile.md',
] as const;

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
export function resolveTemplateDir(): string {
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

/**
 * Raw sync disk read, no Postgres column involved. Internal primitive reused
 * by lib/coreProfileStore.ts and lib/memoryFilesStore.ts for their on-disk
 * legacy-cache fallback/mirror, and by readMemoryFile below for the two
 * filenames that stay disk-only (core-profile.md has its own dedicated
 * column/store; memory-index.md is never Postgres-backed — see
 * POSTGRES_BACKED_FILES above).
 */
export function readMemoryFileFromDisk(userId: string, filename: string): string | null {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return null;
  seedUserMemory(userId);
  try {
    return fs.readFileSync(memoryPath(userId, filename as MemoryFile), 'utf-8');
  } catch {
    return null;
  }
}

/** Raw sync disk write — see readMemoryFileFromDisk. */
export function writeMemoryFileToDisk(userId: string, filename: string, content: string): void {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return;
  seedUserMemory(userId);
  try {
    fs.mkdirSync(getUserMemoryDir(userId), { recursive: true });
    fs.writeFileSync(memoryPath(userId, filename as MemoryFile), content, 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

function isPostgresBacked(filename: string): filename is typeof POSTGRES_BACKED_FILES[number] {
  return (POSTGRES_BACKED_FILES as readonly string[]).includes(filename);
}

/**
 * Reads a memory file's content. core-profile.md and memory-index.md are
 * disk-only (see POSTGRES_BACKED_FILES); the other seven ALLOWED_FILES are
 * canonically stored in `users.memory_files` (lib/memoryFilesStore.ts), with
 * disk kept only as a legacy cache — same split as
 * lib/coreProfileStore.ts's dedicated column for core-profile.md.
 */
export async function readMemoryFile(userId: string, filename: string): Promise<string | null> {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return null;
  if (isPostgresBacked(filename)) return readStoredMemoryFile(userId, filename);
  return readMemoryFileFromDisk(userId, filename);
}

/** Writes a memory file's content. See readMemoryFile for the storage split. */
export async function writeMemoryFile(userId: string, filename: string, content: string): Promise<void> {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return;
  if (isPostgresBacked(filename)) return writeStoredMemoryFile(userId, filename, content);
  writeMemoryFileToDisk(userId, filename, content);
}

export async function appendObservation(userId: string, note: string): Promise<void> {
  const date = new Date().toISOString().split('T')[0];
  const entry = `- [${date}] ${note}`;
  const content = (await readMemoryFile(userId, 'coach-observations.md')) ?? '# Coach Observations\n\n';
  const lines = content.split('\n').filter(l => l.startsWith('- ['));
  lines.unshift(entry);
  const updated = '# Coach Observations\n\n' + lines.slice(0, 30).join('\n') + '\n';
  await writeMemoryFile(userId, 'coach-observations.md', updated);
}

export async function readHrvBaseline(userId: string): Promise<number | null> {
  const profile = await readMemoryFile(userId, 'core-profile.md');
  if (!profile) return null;
  const match = /hrv baseline:\s*(\d+)\s*ms/i.exec(profile);
  return match ? parseInt(match[1], 10) : null;
}

export async function loadAlwaysOnContext(userId: string): Promise<string> {
  const [index, core, conditions, observations, labs] = await Promise.all([
    readMemoryFile(userId, 'memory-index.md'),
    readMemoryFile(userId, 'core-profile.md'),
    readMemoryFile(userId, 'health-conditions.json'),
    readMemoryFile(userId, 'coach-observations.md'),
    readMemoryFile(userId, 'lab-results.json'),
  ]);

  return [
    '## Memory Index\n' + (index ?? ''),
    '## Core Profile\n' + (core ?? ''),
    '## Health Conditions (SAFETY — always follow these)\n```json\n' + (conditions ?? '{}') + '\n```',
    '## Lab Results\n```json\n' + (labs ?? '{}') + '\n```',
    observations ?? '',
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

export async function handleToolCall(userId: string, name: string, input: unknown): Promise<string> {
  const inp = input as Record<string, string>;
  if (name === 'read_memory') {
    return (await readMemoryFile(userId, inp.filename)) ?? `File "${inp.filename}" not found.`;
  }
  if (name === 'write_memory') {
    await writeMemoryFile(userId, inp.filename, inp.content);
    return 'Memory updated.';
  }
  if (name === 'append_observation') {
    await appendObservation(userId, inp.note);
    return 'Observation appended.';
  }
  return 'Unknown tool.';
}
