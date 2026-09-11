CREATE TABLE "notification_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"target_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deep_link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_inbox_type_check" CHECK ("notification_inbox"."type" in ('workout_analysis', 'sleep_analysis', 'morning_brief', 'coach_nudge'))
);
--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_inbox_user_type_target_idx" ON "notification_inbox" USING btree ("user_id","type","target_id");--> statement-breakpoint
CREATE INDEX "notification_inbox_user_created_idx" ON "notification_inbox" USING btree ("user_id","created_at");