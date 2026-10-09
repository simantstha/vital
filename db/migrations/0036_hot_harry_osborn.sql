ALTER TABLE "notification_inbox" DROP CONSTRAINT "notification_inbox_type_check";--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "coach_nudges_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "weekly_review_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_type_check" CHECK ("notification_inbox"."type" in ('workout_analysis', 'sleep_analysis', 'morning_brief', 'coach_nudge', 'weekly_review'));