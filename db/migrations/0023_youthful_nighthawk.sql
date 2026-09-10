ALTER TABLE "pending_nudges" ADD COLUMN "local_day" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_nudges_user_local_day_idx" ON "pending_nudges" USING btree ("user_id","local_day");