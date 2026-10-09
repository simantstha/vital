ALTER TABLE "users" ADD COLUMN "target_weight_kg" real;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_start_weight_kg" real;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weekly_sessions_target" integer;