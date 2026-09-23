ALTER TABLE "messages" ADD COLUMN "client_turn_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_client_turn_idx" ON "messages" USING btree ("user_id","client_turn_id");