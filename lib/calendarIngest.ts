/**
 * Calendar ingest — validation + overlap-replace logic for
 * POST /api/ingest/calendar.
 *
 * Split out of the route handler (same DI pattern as
 * lib/healthAnalysisIngest.ts) so the request validation and the
 * delete-then-insert "full replace" semantics are unit-testable against a
 * fake CalendarIngestStore without touching Postgres. The route wires
 * ingestCalendarBlocks to a Drizzle-backed store that runs the real
 * transaction.
 */

export const MAX_WINDOW_DAYS = 31;
export const MAX_BLOCKS_PER_REQUEST = 500;
export const MAX_TITLE_LEN = 200;

export interface CalendarBlockInput {
  start: string;
  end: string;
  allDay?: boolean;
  title?: string | null;
}

export interface NormalizedCalendarBlock {
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  title: string | null;
}

export interface ValidatedCalendarIngest {
  windowStart: Date;
  windowEnd: Date;
  blocks: NormalizedCalendarBlock[];
}

export type CalendarIngestValidation =
  | { ok: true; value: ValidatedCalendarIngest }
  | { ok: false; error: string };

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isBlockShape(b: unknown): b is CalendarBlockInput {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  if (typeof o.start !== 'string' || typeof o.end !== 'string') return false;
  if (o.allDay !== undefined && typeof o.allDay !== 'boolean') return false;
  if (o.title !== undefined && o.title !== null && typeof o.title !== 'string') return false;
  return true;
}

/**
 * Validates + normalizes a raw request body into a window + block set ready
 * for the store. Returns an error string (400-worthy) on any problem.
 */
export function validateCalendarIngestBody(body: unknown): CalendarIngestValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must be { windowStart, windowEnd, blocks }.' };
  }
  const o = body as Record<string, unknown>;

  const windowStart = parseDate(o.windowStart);
  const windowEnd = parseDate(o.windowEnd);
  if (!windowStart || !windowEnd) {
    return { ok: false, error: 'windowStart and windowEnd must be parseable ISO dates.' };
  }
  if (windowEnd.getTime() <= windowStart.getTime()) {
    return { ok: false, error: 'windowEnd must be after windowStart.' };
  }
  const windowDays = (windowEnd.getTime() - windowStart.getTime()) / 86_400_000;
  if (windowDays > MAX_WINDOW_DAYS) {
    return {
      ok: false,
      error: `Window too large: ${windowDays.toFixed(1)} days exceeds the ${MAX_WINDOW_DAYS}-day cap.`,
    };
  }

  if (!Array.isArray(o.blocks)) {
    return { ok: false, error: 'blocks must be an array.' };
  }
  if (o.blocks.length > MAX_BLOCKS_PER_REQUEST) {
    return {
      ok: false,
      error: `Too many blocks: ${o.blocks.length} exceeds the ${MAX_BLOCKS_PER_REQUEST}-block cap.`,
    };
  }

  const invalidShape = o.blocks.filter((b) => !isBlockShape(b));
  if (invalidShape.length > 0) {
    return {
      ok: false,
      error: `${invalidShape.length} block(s) are malformed (need start, end, optional allDay/title).`,
    };
  }

  const blocks: NormalizedCalendarBlock[] = [];
  for (const raw of o.blocks as CalendarBlockInput[]) {
    const start = parseDate(raw.start);
    const end = parseDate(raw.end);
    if (!start || !end) {
      return { ok: false, error: 'Each block needs parseable start/end dates.' };
    }
    if (end.getTime() <= start.getTime()) {
      return { ok: false, error: 'Each block end must be after its start.' };
    }
    const trimmedTitle = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_TITLE_LEN) : '';
    blocks.push({
      startAt: start,
      endAt: end,
      allDay: raw.allDay ?? false,
      title: trimmedTitle.length > 0 ? trimmedTitle : null,
    });
  }

  return { ok: true, value: { windowStart, windowEnd, blocks } };
}

/**
 * Deletes existing calendar_blocks rows overlapping [windowStart, windowEnd)
 * for the user, then inserts `blocks`. Overlap (not exact-window) delete
 * means a block that started before the window but runs into it is cleaned
 * up too, so a shifted re-sync never leaves a stale duplicate at the seam.
 * Returns the number of rows inserted.
 */
export interface CalendarIngestStore {
  replaceWindow(
    userId: string,
    windowStart: Date,
    windowEnd: Date,
    blocks: NormalizedCalendarBlock[],
  ): Promise<number>;
}

export async function ingestCalendarBlocks(
  store: CalendarIngestStore,
  userId: string,
  parsed: ValidatedCalendarIngest,
): Promise<{ replaced: number }> {
  const replaced = await store.replaceWindow(userId, parsed.windowStart, parsed.windowEnd, parsed.blocks);
  return { replaced };
}
