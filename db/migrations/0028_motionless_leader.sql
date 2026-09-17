ALTER TABLE "nodes" ADD COLUMN "subject_node_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_subject_node_id_nodes_id_fk" FOREIGN KEY ("subject_node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_user_subject_idx" ON "nodes" USING btree ("user_id","subject_node_id");