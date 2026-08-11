ALTER TABLE "nodes" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "nodes_user_status_idx" ON "nodes" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_status_check" CHECK ("nodes"."status" in ('active', 'resolved'));