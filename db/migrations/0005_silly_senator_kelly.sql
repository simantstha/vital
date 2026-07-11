CREATE TABLE "specialist_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"manifest_id" text NOT NULL,
	"manifest_version" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"inbound_handoff" jsonb NOT NULL,
	"return_handoff" jsonb,
	"failure_reason" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"return_proposed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialist_sessions_status_check" CHECK ("specialist_sessions"."status" in ('proposed', 'active', 'return_proposed', 'completed', 'declined', 'failed')),
	CONSTRAINT "specialist_sessions_expiry_check" CHECK ((("specialist_sessions"."status" in ('proposed', 'return_proposed')) = ("specialist_sessions"."expires_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "speaker" text DEFAULT 'coach' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "specialist_session_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "specialist_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "specialist_sessions" ADD CONSTRAINT "specialist_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_sessions_one_open_per_user_idx" ON "specialist_sessions" USING btree ("user_id") WHERE "specialist_sessions"."status" in ('proposed', 'active', 'return_proposed');--> statement-breakpoint
CREATE INDEX "specialist_sessions_user_updated_idx" ON "specialist_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_specialist_session_id_specialist_sessions_id_fk" FOREIGN KEY ("specialist_session_id") REFERENCES "public"."specialist_sessions"("id") ON DELETE no action ON UPDATE no action;