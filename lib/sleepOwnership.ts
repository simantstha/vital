/**
 * Sleep-night ownership rules for the phase-2 "both devices" contract (PR A,
 * "Sleep ownership"). Pure, DB-free — same split as lib/analysisSession.ts's
 * workout same-session logic.
 *
 * One `sleep_analyses` row exists per (user_id, wake_date). Exactly one
 * source "owns" that row (its payload is `source`/`input_payload`, the one
 * fed to the model and shown as the primary analysis); the other source's
 * payload, when it arrives for the same night, is preserved in
 * `secondary_source`/`secondary_payload` rather than being dropped — the
 * contract's whole point ("Today the code does `if (persisted?.source ===
 * 'whoop') continue;`, which loses the HealthKit night.").
 *
 * `preferredDevice` is `users.primary_sleep_device`:
 *  - null/undefined/'whoop': WHOOP owns the night (today's behavior, made
 *    explicit — 'whoop' is the same as leaving it unset).
 *  - 'apple': HealthKit owns the night, symmetrically.
 *
 * The already-notified rule from the original multi-device-analyses contract
 * still holds: a row that's already been notified is never overwritten or
 * demoted from being the primary row — but the OTHER device's payload for
 * that same night is still captured as secondary rather than thrown away.
 */

export type SleepSource = 'healthkit' | 'whoop';
export type SleepDevicePreference = 'apple' | 'whoop' | null | undefined;

export interface PersistedSleepOwnership {
  source: SleepSource;
  /** Already delivered a push for this row — makes its primary/owning slot untouchable. */
  notified: boolean;
}

/** The source that owns the night under this preference — 'apple' maps to 'healthkit'; anything else ('whoop', null, undefined) maps to 'whoop'. */
export function sleepOwnerSource(preferredDevice: SleepDevicePreference): SleepSource {
  return preferredDevice === 'apple' ? 'healthkit' : 'whoop';
}

export interface SleepWriteDecision {
  /**
   * 'primary': `incomingSource` becomes (or stays) the owning row — write its
   *   payload into source/input_payload.
   * 'secondary': the owning row is untouched; store `incomingSource`'s
   *   payload into secondary_source/secondary_payload instead of dropping it.
   */
  action: 'primary' | 'secondary';
  /**
   * Only meaningful when action === 'primary' and a persisted row already
   * exists from the OTHER source: that persisted row's payload must be
   * archived into secondary_source/secondary_payload before being
   * overwritten, rather than lost — the ownership just changed hands (e.g. a
   * preference flip, or the owning device's data hasn't arrived yet and this
   * is the first write for the night).
   */
  archivePersistedAsSecondary: boolean;
}

/**
 * Decides what an incoming sleep payload for one wake_date should do, given
 * whatever is already persisted for that night (or `null` — nothing yet) and
 * the user's sleep-device preference. Called identically from both ingest
 * paths (lib/healthAnalysisIngest.ts for HealthKit, lib/whoop/sync.ts for
 * WHOOP) with `incomingSource` set to their own source.
 */
export function resolveSleepWrite(input: {
  persisted: PersistedSleepOwnership | null;
  incomingSource: SleepSource;
  preferredDevice: SleepDevicePreference;
}): SleepWriteDecision {
  const { persisted, incomingSource, preferredDevice } = input;

  if (!persisted) return { action: 'primary', archivePersistedAsSecondary: false };

  // Same source re-arriving (a re-sync, a re-upload) is always a normal
  // refresh of the primary row — never a secondary write.
  if (persisted.source === incomingSource) {
    return { action: 'primary', archivePersistedAsSecondary: false };
  }

  const owner = sleepOwnerSource(preferredDevice);
  if (incomingSource !== owner) {
    // The persisted row must already be the owner (only two sources exist),
    // so it stays primary; the non-owning incoming payload is preserved as
    // secondary rather than dropped.
    return { action: 'secondary', archivePersistedAsSecondary: false };
  }

  // Incoming is the owner, but a different source currently holds the
  // primary slot (e.g. the owner's data hasn't arrived yet and the other
  // device wrote first, or the preference just changed). Take over the
  // primary slot UNLESS the persisted row was already notified (never
  // un-send a notification) — then keep it primary and store the owner's
  // payload as secondary instead.
  if (persisted.notified) return { action: 'secondary', archivePersistedAsSecondary: false };
  return { action: 'primary', archivePersistedAsSecondary: true };
}
