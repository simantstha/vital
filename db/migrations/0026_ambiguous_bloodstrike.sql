ALTER TABLE "nodes" DROP CONSTRAINT "nodes_status_check";--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_superseded_by_nodes_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_status_check" CHECK ("nodes"."status" in ('active', 'resolved', 'superseded'));