CREATE TABLE "morning_notification_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"claimed_by" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"idempotency_key" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "morning_notification_slots_claimed_by_check" CHECK ("morning_notification_slots"."claimed_by" in ('sleep', 'brief')),
	CONSTRAINT "morning_notification_slots_status_check" CHECK ("morning_notification_slots"."status" in ('claimed', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"morning_brief_enabled" boolean DEFAULT true NOT NULL,
	"morning_brief_time_minutes" integer DEFAULT 450 NOT NULL,
	"workout_notifications_enabled" boolean DEFAULT true NOT NULL,
	"sleep_notifications_enabled" boolean DEFAULT true NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_morning_time_check" CHECK ("notification_preferences"."morning_brief_time_minutes" between 0 and 1439)
);
--> statement-breakpoint
CREATE TABLE "push_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"push_device_id" uuid,
	"idempotency_key" text NOT NULL,
	"notification_type" text NOT NULL,
	"target_id" uuid,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"apns_status" integer,
	"failure_category" text,
	"latency_ms" integer,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_attempts_status_check" CHECK ("push_attempts"."status" in ('pending', 'sent', 'transient_failure', 'permanent_failure'))
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"device_token" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "push_devices_environment_check" CHECK ("push_devices"."environment" in ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE TABLE "sleep_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wake_date" date NOT NULL,
	"content_fingerprint" text NOT NULL,
	"input_payload" jsonb NOT NULL,
	"analyze_after" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"notification_state" text DEFAULT 'pending' NOT NULL,
	"notification_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sleep_analyses_status_check" CHECK ("sleep_analyses"."status" in ('pending', 'processing', 'ready', 'failed', 'deleted')),
	CONSTRAINT "sleep_analyses_notification_state_check" CHECK ("sleep_analyses"."notification_state" in ('pending', 'suppressed', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workout_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hk_uuid" text NOT NULL,
	"workout_date" date NOT NULL,
	"content_fingerprint" text NOT NULL,
	"input_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"notification_state" text DEFAULT 'pending' NOT NULL,
	"notification_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workout_analyses_status_check" CHECK ("workout_analyses"."status" in ('pending', 'processing', 'ready', 'failed', 'deleted')),
	CONSTRAINT "workout_analyses_notification_state_check" CHECK ("workout_analyses"."notification_state" in ('pending', 'suppressed', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "morning_notification_slots" ADD CONSTRAINT "morning_notification_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_attempts" ADD CONSTRAINT "push_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_attempts" ADD CONSTRAINT "push_attempts_push_device_id_push_devices_id_fk" FOREIGN KEY ("push_device_id") REFERENCES "public"."push_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ADD CONSTRAINT "sleep_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD CONSTRAINT "workout_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "morning_notification_slots_user_date_idx" ON "morning_notification_slots" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "morning_notification_slots_idempotency_idx" ON "morning_notification_slots" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_attempts_idempotency_attempt_idx" ON "push_attempts" USING btree ("idempotency_key","attempt_number");--> statement-breakpoint
CREATE INDEX "push_attempts_user_attempted_idx" ON "push_attempts" USING btree ("user_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_installation_idx" ON "push_devices" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_environment_idx" ON "push_devices" USING btree ("device_token","environment");--> statement-breakpoint
CREATE INDEX "push_devices_user_active_idx" ON "push_devices" USING btree ("user_id","invalidated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sleep_analyses_user_wake_date_idx" ON "sleep_analyses" USING btree ("user_id","wake_date");--> statement-breakpoint
CREATE INDEX "sleep_analyses_queue_idx" ON "sleep_analyses" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_analyses_user_hk_uuid_idx" ON "workout_analyses" USING btree ("user_id","hk_uuid");--> statement-breakpoint
CREATE INDEX "workout_analyses_queue_idx" ON "workout_analyses" USING btree ("status","next_attempt_at");