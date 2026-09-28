ALTER TABLE "sleep_analyses" ADD COLUMN "secondary_source" text;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "secondary_payload" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "primary_workout_device" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "primary_sleep_device" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "primary_recovery_device" text;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD CONSTRAINT "workout_analyses_merged_into_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."workout_analyses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD CONSTRAINT "sleep_analyses_secondary_source_check" CHECK ("sleep_analyses"."secondary_source" in ('healthkit', 'whoop'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_workout_device_check" CHECK ("users"."primary_workout_device" in ('apple', 'whoop'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_sleep_device_check" CHECK ("users"."primary_sleep_device" in ('apple', 'whoop'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_recovery_device_check" CHECK ("users"."primary_recovery_device" in ('apple', 'whoop'));