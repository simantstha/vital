import fs from 'fs';
import path from 'path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

const MEMORY_DIR = path.resolve(process.cwd(), '.vital-memory');

const ALLOWED_FILES = [
  'memory-index.md',
  'core-profile.md',
  'coach-observations.md',
  'health-conditions.json',
  'training-history.json',
  'nutrition-habits.json',
  'life-context.json',
  'lab-results.json',
] as const;

type MemoryFile = typeof ALLOWED_FILES[number];

function memoryPath(filename: MemoryFile): string {
  return path.join(MEMORY_DIR, filename);
}

export function readMemoryFile(filename: string): string | null {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return null;
  try {
    return fs.readFileSync(memoryPath(filename as MemoryFile), 'utf-8');
  } catch {
    return null;
  }
}

export function writeMemoryFile(filename: string, content: string): void {
  if (!ALLOWED_FILES.includes(filename as MemoryFile)) return;
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(memoryPath(filename as MemoryFile), content, 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

export function appendObservation(note: string): void {
  const date = new Date().toISOString().split('T')[0];
  const entry = `- [${date}] ${note}`;
  const content = readMemoryFile('coach-observations.md') ?? '# Coach Observations\n\n';
  const lines = content.split('\n').filter(l => l.startsWith('- ['));
  lines.unshift(entry);
  const updated = '# Coach Observations\n\n' + lines.slice(0, 30).join('\n') + '\n';
  writeMemoryFile('coach-observations.md', updated);
}

export function readHrvBaseline(): number | null {
  const profile = readMemoryFile('core-profile.md');
  if (!profile) return null;
  const match = /hrv baseline:\s*(\d+)\s*ms/i.exec(profile);
  return match ? parseInt(match[1], 10) : null;
}

export function loadAlwaysOnContext(): string {
  const index = readMemoryFile('memory-index.md') ?? '';
  const core = readMemoryFile('core-profile.md') ?? '';
  const conditions = readMemoryFile('health-conditions.json') ?? '{}';
  const observations = readMemoryFile('coach-observations.md') ?? '';
  const labs = readMemoryFile('lab-results.json') ?? '{}';

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
          enum: ['health-conditions.json', 'training-history.json', 'nutrition-habits.json', 'life-context.json', 'core-profile.md', 'lab-results.json'],
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

export function handleToolCall(name: string, input: unknown): string {
  const inp = input as Record<string, string>;
  if (name === 'read_memory') {
    return readMemoryFile(inp.filename) ?? `File "${inp.filename}" not found.`;
  }
  if (name === 'write_memory') {
    writeMemoryFile(inp.filename, inp.content);
    return 'Memory updated.';
  }
  if (name === 'append_observation') {
    appendObservation(inp.note);
    return 'Observation appended.';
  }
  return 'Unknown tool.';
}
