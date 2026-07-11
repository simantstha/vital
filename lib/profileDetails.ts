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
