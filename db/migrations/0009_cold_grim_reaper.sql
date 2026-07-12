ALTER TABLE "specialist_sessions" ADD COLUMN "card_occurrence_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "specialist_actions" ADD COLUMN "card_occurrence_id" uuid;--> statement-breakpoint
UPDATE "specialist_actions" AS actions
SET "card_occurrence_id" = sessions."card_occurrence_id"
FROM "specialist_sessions" AS sessions
WHERE actions."session_id" = sessions."id";--> statement-breakpoint
ALTER TABLE "specialist_actions" ALTER COLUMN "card_occurrence_id" SET NOT NULL;
