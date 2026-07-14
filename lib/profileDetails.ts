import { readMemoryFile, writeMemoryFile } from './memory';

export type ProfileDetails = {
  age: number | null;
  biologicalSex: string | null;
  heightCm: number | null;
  weightKg: number | null;
};

const PLACEHOLDER_VALUES = new Set([
  '',
  'n/a',
  'na',
  'none',
  'not yet established',
  'not specified yet',
  'null',
  'unknown',
  'undefined',
]);

function nullableText(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || /^\[.*\]$/.test(normalized) || PLACEHOLDER_VALUES.has(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

function parsePositiveNumber(value: string, unit: string): number | null {
  const match = new RegExp(`^([0-9]+(?:\\.[0-9]+)?)\\s*${unit}$`, 'i').exec(value.trim());
  if (!match) return null;

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseAge(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const age = Number(normalized);
  return Number.isSafeInteger(age) && age >= 0 ? age : null;
}

function parseIdentityField(lines: string[], label: string): string | null {
  const prefix = `- ${label}:`;
  const line = lines.find((candidate) => candidate.trimStart().startsWith(prefix));
  return line ? nullableText(line.slice(line.indexOf(prefix) + prefix.length)) : null;
}

export function parseProfileDetails(markdown: string | null | undefined): ProfileDetails {
  const details: ProfileDetails = {
    age: null,
    biologicalSex: null,
    heightCm: null,
    weightKg: null,
  };

  if (!markdown) return details;

  const identityLines: string[] = [];
  let inIdentity = false;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inIdentity = heading[1] === 'Identity';
      continue;
    }
    if (inIdentity) identityLines.push(line);
  }

  const age = parseIdentityField(identityLines, 'Age');
  const biologicalSex = parseIdentityField(identityLines, 'Sex');
  const height = parseIdentityField(identityLines, 'Height');
  const currentWeight = parseIdentityField(identityLines, 'Current weight');

  details.age = age == null ? null : parseAge(age);
  details.biologicalSex = biologicalSex;
  details.heightCm = height == null ? null : parsePositiveNumber(height, 'cm');

  if (currentWeight != null) {
    const weightValue = /^(.*?)\s*(?:—|-)?\s*last updated\b.*$/i.exec(currentWeight)?.[1] ?? currentWeight;
    details.weightKg = parsePositiveNumber(weightValue, 'kg');
  }

  return details;
}

// ── core-profile.md Identity patch (Profile PATCH endpoint) ─────────────────

export type IdentityPatch = {
  age?: number;
  heightCm?: number;
  weightKg?: number;
};

/**
 * Partial, section-aware patch of the `## Identity` lines in core-profile.md.
 * Mirrors the section-walk in app/api/onboarding/route.ts's fillCoreProfile,
 * but only rewrites the specific fields present in `patch` (undefined fields
 * are left untouched) rather than always filling all four from a full
 * onboarding payload — so it's safe to call from the profile PATCH route
 * with just the fields the user actually changed.
 *
 * No-ops silently (does not write) if the user has no core-profile.md yet
 * (not onboarded) or if `patch` has no defined fields.
 */
export function updateIdentityLines(userId: string, patch: IdentityPatch): void {
  const hasAge = patch.age !== undefined;
  const hasHeight = patch.heightCm !== undefined;
  const hasWeight = patch.weightKg !== undefined;
  if (!hasAge && !hasHeight && !hasWeight) return;

  const content = readMemoryFile(userId, 'core-profile.md');
  if (content == null) return;

  const today = new Date().toISOString().split('T')[0];

  let section = '';
  const lines = content.split('\n').map((line) => {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      return line;
    }

    if (section === 'Identity') {
      if (hasAge && /^- Age:/.test(line)) return `- Age: ${patch.age}`;
      if (hasHeight && /^- Height:/.test(line)) return `- Height: ${patch.heightCm} cm`;
      if (hasWeight && /^- Current weight:/.test(line)) {
        return `- Current weight: ${patch.weightKg} kg — last updated ${today}`;
      }
    }

    return line;
  });

  writeMemoryFile(userId, 'core-profile.md', lines.join('\n'));
}

// ── Sleep goal subtitle formatting (shared between /api/plan seed + PATCH) ──

/**
 * Formats a sleep-goal-minutes value as e.g. "8h target — your biggest lever
 * this week" / "7.5h target — your biggest lever this week". Hours show a
 * ".5" only when minutes aren't an exact multiple of 60.
 */
export function formatSleepSubtitle(sleepGoalMinutes: number): string {
  const hours = sleepGoalMinutes / 60;
  const hoursLabel = Number.isInteger(hours) ? `${hours}` : `${Math.round(hours * 2) / 2}`;
  return `${hoursLabel}h target — your biggest lever this week`;
}
