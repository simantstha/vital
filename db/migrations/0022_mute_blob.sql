CREATE TABLE "insight_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"kind" text NOT NULL,
	"computed_for" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_nudges" ADD COLUMN "finding_kind" text;--> statement-breakpoint
ALTER TABLE "insight_findings" ADD CONSTRAINT "insight_findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insight_findings_user_signature_day_idx" ON "insight_findings" USING btree ("user_id","signature","computed_for");--> statement-breakpoint
CREATE INDEX "insight_findings_user_signature_idx" ON "insight_findings" USING btree ("user_id","signature");--> statement-breakpoint
CREATE INDEX "pending_nudges_user_kind_sent_idx" ON "pending_nudges" USING btree ("user_id","finding_kind","sent_at");