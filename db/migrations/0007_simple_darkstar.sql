CREATE TABLE "specialist_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"action" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "specialist_actions" ADD CONSTRAINT "specialist_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_actions" ADD CONSTRAINT "specialist_actions_session_id_specialist_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."specialist_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_actions_user_action_idx" ON "specialist_actions" USING btree ("user_id","action_id");--> statement-breakpoint
CREATE INDEX "specialist_actions_session_idx" ON "specialist_actions" USING btree ("session_id");