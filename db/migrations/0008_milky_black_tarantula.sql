ALTER TABLE "morning_notification_slots" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "morning_notification_slots" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "morning_notification_slots" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "morning_notification_slots" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "notification_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "notification_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "notification_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD COLUMN "notification_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "notification_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "notification_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "notification_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD COLUMN "notification_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;