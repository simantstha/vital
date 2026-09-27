ALTER TABLE "sleep_analyses" ADD COLUMN "source" text DEFAULT 'healthkit' NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "source" text DEFAULT 'healthkit' NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD CONSTRAINT "sleep_analyses_source_check" CHECK ("sleep_analyses"."source" in ('healthkit', 'whoop'));--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD CONSTRAINT "workout_analyses_source_check" CHECK ("workout_analyses"."source" in ('healthkit', 'whoop'));--> statement-breakpoint
-- Custom SQL migration file, put your code below! ---------------------------
--
-- Backfill workout_analyses.started_at/ended_at for existing rows (all
-- 'healthkit' at this point — WHOOP rows didn't exist before this migration)
-- from input_payload's startTime/durationMin, the same shape
-- lib/proactiveAnalysisFormatting.ts's formatWorkoutInput already reads (see
-- app/api/ingest/daily/route.ts's workout payload). These two columns back
-- the same-session overlap rule in lib/analysisSession.ts, which lets a WHOOP
-- workout dedupe against the Apple Watch's own copy of the same session.
--
-- Pure UPDATE, no DDL beyond the ADD COLUMNs above: additive-safe, safe to run
-- while old and new app code are both live (old code never reads or writes
-- these columns).
--
-- Only rows whose input_payload actually has both fields in a parseable shape
-- are touched; anything else (missing field, non-ISO startTime, non-numeric
-- durationMin) is left with started_at/ended_at NULL rather than guessed —
-- "rows that can't be parsed stay null" per the multi-device-analyses
-- contract. The two regexes gate the casts below so a single malformed row
-- can't fail the whole migration with a cast error.
UPDATE workout_analyses
SET
  started_at = (input_payload->>'startTime')::timestamptz,
  ended_at = (input_payload->>'startTime')::timestamptz
    + ((input_payload->>'durationMin')::numeric * interval '1 minute')
WHERE started_at IS NULL
  AND input_payload ? 'startTime'
  AND input_payload ? 'durationMin'
  AND jsonb_typeof(input_payload->'durationMin') = 'number'
  AND input_payload->>'startTime' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$';