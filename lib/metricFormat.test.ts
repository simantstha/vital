import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDistance,
  formatHeight,
  formatKilometres,
  formatMinutes,
  formatPace,
  formatPaceMinPerKm,
  formatWeight,
  paceSuffix,
  roundInteger,
  roundTo,
} from './metricFormat';

test('roundInteger rounds and rejects non-finite input', () => {
  assert.equal(roundInteger(47.29999923706055), 47);
  assert.equal(roundInteger(-3.5), -3); // Math.round rounds half towards +Infinity
  assert.equal(roundInteger(NaN), null);
  assert.equal(roundInteger(Infinity), null);
  assert.equal(roundInteger('45' as unknown), null);
  assert.equal(roundInteger(null), null);
  assert.equal(roundInteger(undefined), null);
});

test('roundTo rounds to the given decimal place and rejects non-finite input', () => {
  assert.equal(roundTo(45.649, 1), 45.6);
  assert.equal(roundTo(45.65, 1), 45.7);
  assert.equal(roundTo(45, 1), 45);
  assert.equal(roundTo(NaN, 1), null);
  assert.equal(roundTo(Infinity, 1), null);
});

test('formatMinutes reads "N min" under an hour, else "Xh YYm"', () => {
  assert.equal(formatMinutes(59), '59 min');
  assert.equal(formatMinutes(60), '1h 00m');
  assert.equal(formatMinutes(0), '0 min');
  assert.equal(formatMinutes(410), '6h 50m');
  assert.equal(formatMinutes(NaN), null);
  assert.equal(formatMinutes(Infinity), null);
  assert.equal(formatMinutes('60' as unknown), null);
});

test('formatKilometres renders one decimal place from a metre distance', () => {
  assert.equal(formatKilometres(8437), '8.4 km');
  assert.equal(formatKilometres(1000), '1.0 km');
  assert.equal(formatKilometres(NaN), null);
});

test('formatPaceMinPerKm renders minutes and seconds, rounding the fractional minute', () => {
  assert.equal(formatPaceMinPerKm(5.999), '6′00″');
  assert.equal(formatPaceMinPerKm(5.383), '5′23″');
  assert.equal(formatPaceMinPerKm(0), '0′00″');
  assert.equal(formatPaceMinPerKm(-1), null);
  assert.equal(formatPaceMinPerKm(NaN), null);
});

test('formatDistance renders km for metric and mi for imperial; rejects non-finite input', () => {
  assert.equal(formatDistance(8437), '8.4 km');
  assert.equal(formatDistance(8437, 'metric'), '8.4 km');
  assert.equal(formatDistance(8437, 'imperial'), '5.2 mi');
  assert.equal(formatDistance(1000, 'imperial'), '0.6 mi');
  assert.equal(formatDistance(NaN, 'imperial'), null);
  assert.equal(formatDistance(Infinity, 'imperial'), null);
});

test('paceSuffix returns /km for metric (default) and /mi for imperial', () => {
  assert.equal(paceSuffix(), '/km');
  assert.equal(paceSuffix('metric'), '/km');
  assert.equal(paceSuffix('imperial'), '/mi');
});

test('formatPace renders minutes-per-km for metric and converts to minutes-per-mile for imperial; rejects non-finite/negative input', () => {
  assert.equal(formatPace(5.383), '5′23″');
  assert.equal(formatPace(5.383, 'metric'), '5′23″');
  assert.equal(formatPace(5.383, 'imperial'), '8′40″');
  assert.equal(formatPace(0, 'imperial'), '0′00″');
  assert.equal(formatPace(-1, 'imperial'), null);
  assert.equal(formatPace(NaN, 'imperial'), null);
});

test('formatWeight renders kg (1dp) for metric and lb (rounded) for imperial; rejects non-finite input', () => {
  assert.equal(formatWeight(81.2), '81.2 kg');
  assert.equal(formatWeight(81.2, 'metric'), '81.2 kg');
  assert.equal(formatWeight(81.2, 'imperial'), '179 lb');
  assert.equal(formatWeight(NaN, 'imperial'), null);
  assert.equal(formatWeight(Infinity, 'imperial'), null);
});

test('formatHeight renders cm (rounded) for metric and feet/inches for imperial; rejects non-finite input', () => {
  assert.equal(formatHeight(180), '180 cm');
  assert.equal(formatHeight(180, 'metric'), '180 cm');
  assert.equal(formatHeight(180, 'imperial'), `5'11"`);
  assert.equal(formatHeight(NaN, 'imperial'), null);
  assert.equal(formatHeight(Infinity, 'imperial'), null);
});
