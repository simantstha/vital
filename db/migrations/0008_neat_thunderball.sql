ALTER TABLE "specialist_actions" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "specialist_actions" ADD COLUMN "completed_at" timestamp with time zone;