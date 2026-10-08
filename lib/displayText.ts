/**
 * Vital — tiny display-text helpers shared by the user-facing copy builders
 * (lib/goalProgress.ts, lib/weeklyReview.ts). Pure, import-free.
 *
 * Why: a value must never wrap in the middle on a narrow line ("+20 / kg",
 * "143 → / 163 kg"). Joining a number to its unit, and the two halves of an
 * "a → b" pair, with U+00A0 lets a line break BETWEEN tokens but not inside
 * one. Coach-context strings (lib/goalPromptText.ts) are not display copy and
 * stay plain; use `plainSpaces` when display copy is embedded in a prompt.
 */

/** U+00A0 NO-BREAK SPACE. */
export const NBSP = ' ';

/** "24.5 km" / "2,000 kcal" with a non-breaking space between number and unit. */
export function withUnit(value: number | string, unit: string): string {
  return `${value}${NBSP}${unit}`;
}

/** "143 → 163" with non-breaking spaces around the arrow, so the pair stays whole. */
export function arrowPair(from: string, to: string): string {
  return `${from}${NBSP}→${NBSP}${to}`;
}

/** Display copy with every NBSP replaced by a plain space (coach prompts, plain-text comparisons). */
export function plainSpaces(text: string): string {
  return text.replace(/ /g, ' ');
}
