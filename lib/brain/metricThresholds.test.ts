import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ESTABLISHED_MIN_DAYS,
  RELATIVE_SD_FLOOR,
  MIN_MEANINGFUL_SD,
  METRIC_DIRECTION,
} from './metricThresholds';
import { METRIC_CATALOG } from '../metricCatalog';

/**
 * Unit tests for lib/brain/metricThresholds.ts — pure config, no DATABASE_URL
 * required (this file never imports anything that pulls in @/db).
 */

const DIETARY_METRICS = ['dietary_energy_kcal', 'dietary_protein_g', 'dietary_carbs_g', 'dietary_fat_g'];

test('ESTABLISHED_MIN_DAYS and RELATIVE_SD_FLOOR are the expected constants', () => {
  assert.equal(ESTABLISHED_MIN_DAYS, 14);
  assert.equal(RELATIVE_SD_FLOOR, 0.02);
});

test('sleep_minutes floor is the Swift 0.15h value converted to storage minutes (scale 1/60)', () => {
  const swiftDisplayValue = 0.15; // hours, from MetricCatalog.swift
  const scale = METRIC_CATALOG.sleep_minutes.scale;
  assert.equal(scale, 1 / 60);
  const expectedStorage = swiftDisplayValue / scale;
  assert.equal(expectedStorage, 9);
  assert.equal(MIN_MEANINGFUL_SD.sleep_minutes, 9);
});

test('distance_m floor is the Swift 0.1km value converted to storage metres (scale 1/1000)', () => {
  const swiftDisplayValue = 0.1; // km, from MetricCatalog.swift
  const scale = METRIC_CATALOG.distance_m.scale;
  assert.equal(scale, 1 / 1000);
  const expectedStorage = swiftDisplayValue / scale;
  assert.equal(expectedStorage, 100);
  assert.equal(MIN_MEANINGFUL_SD.distance_m, 100);
});

test('every MIN_MEANINGFUL_SD key exists in METRIC_CATALOG', () => {
  for (const key of Object.keys(MIN_MEANINGFUL_SD)) {
    assert.ok(METRIC_CATALOG[key], `MIN_MEANINGFUL_SD has key "${key}" not present in METRIC_CATALOG`);
  }
});

test('every METRIC_DIRECTION key exists in METRIC_CATALOG', () => {
  for (const key of Object.keys(METRIC_DIRECTION)) {
    assert.ok(METRIC_CATALOG[key], `METRIC_DIRECTION has key "${key}" not present in METRIC_CATALOG`);
  }
});

test('dietary_* metrics are absent from both MIN_MEANINGFUL_SD and METRIC_DIRECTION', () => {
  for (const key of DIETARY_METRICS) {
    assert.ok(!(key in MIN_MEANINGFUL_SD), `MIN_MEANINGFUL_SD should not have a floor for "${key}"`);
    assert.ok(!(key in METRIC_DIRECTION), `METRIC_DIRECTION should not have a polarity for "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// Drift guard: read the Swift catalog straight off disk and assert the TS
// tables agree after unit conversion. This is what stops the two languages
// silently diverging as either catalog gets edited in isolation.
// ---------------------------------------------------------------------------

interface SwiftMetricEntry {
  key: string;
  polarity: 'higherIsBetter' | 'lowerIsBetter' | 'neutral';
  minMeaningfulSD: number;
}

function parseSwiftCatalog(): SwiftMetricEntry[] {
  const swiftPath = join(
    __dirname,
    '../../ios/Vital/Sources/Features/Trends/MetricCatalog.swift',
  );
  const source = readFileSync(swiftPath, 'utf8');

  // Each catalog line looks like:
  // MetricSpec(key: "hrv_sdnn", displayName: "HRV", shortName: "HRV", group: .recovery, polarity: .higherIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),
  const lineRe =
    /MetricSpec\(key:\s*"([^"]+)".*?polarity:\s*\.(\w+).*?minMeaningfulSD:\s*([\d.]+)\)/g;

  const entries: SwiftMetricEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(source)) !== null) {
    const [, key, polarity, sdRaw] = match;
    entries.push({
      key,
      polarity: polarity as SwiftMetricEntry['polarity'],
      minMeaningfulSD: Number(sdRaw),
    });
  }
  return entries;
}

test('drift guard: Swift MetricCatalog.swift has exactly 19 entries', () => {
  const entries = parseSwiftCatalog();
  assert.equal(entries.length, 19, 'expected the regex to find all 19 Swift catalog entries — did the source format change?');
});

test('drift guard: TS METRIC_DIRECTION agrees with Swift polarity for every shared key', () => {
  const entries = parseSwiftCatalog();
  assert.ok(entries.length > 0, 'parseSwiftCatalog found no entries — regex likely broke');
  for (const entry of entries) {
    assert.equal(
      METRIC_DIRECTION[entry.key],
      entry.polarity,
      `polarity mismatch for "${entry.key}": TS has "${METRIC_DIRECTION[entry.key]}", Swift has "${entry.polarity}"`,
    );
  }
});

test('drift guard: TS MIN_MEANINGFUL_SD agrees with Swift minMeaningfulSD (converted to storage units) for every shared key', () => {
  const entries = parseSwiftCatalog();
  assert.ok(entries.length > 0, 'parseSwiftCatalog found no entries — regex likely broke');
  for (const entry of entries) {
    const spec = METRIC_CATALOG[entry.key];
    assert.ok(spec, `Swift key "${entry.key}" missing from METRIC_CATALOG`);
    const expectedStorage = entry.minMeaningfulSD / spec.scale;
    const actualStorage = MIN_MEANINGFUL_SD[entry.key];
    assert.ok(
      actualStorage !== undefined,
      `MIN_MEANINGFUL_SD is missing "${entry.key}", which Swift defines`,
    );
    // Floating point tolerance for the division above.
    assert.ok(
      Math.abs(actualStorage - expectedStorage) < 1e-9,
      `minMeaningfulSD mismatch for "${entry.key}": TS storage-unit value ${actualStorage}, expected ${expectedStorage} (Swift display value ${entry.minMeaningfulSD} / scale ${spec.scale})`,
    );
  }
});

test('drift guard: TS tables have no extra keys beyond the Swift catalog (plus documented dietary_* omission)', () => {
  const entries = parseSwiftCatalog();
  const swiftKeys = new Set(entries.map((e) => e.key));
  for (const key of Object.keys(MIN_MEANINGFUL_SD)) {
    assert.ok(swiftKeys.has(key), `MIN_MEANINGFUL_SD has key "${key}" with no Swift catalog counterpart`);
  }
  for (const key of Object.keys(METRIC_DIRECTION)) {
    assert.ok(swiftKeys.has(key), `METRIC_DIRECTION has key "${key}" with no Swift catalog counterpart`);
  }
});
