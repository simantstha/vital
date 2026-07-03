CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_node" uuid NOT NULL,
	"to_node" uuid NOT NULL,
	"predicate" text NOT NULL,
	"properties" jsonb,
	"weight" real DEFAULT 0.9 NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reinforced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"images" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"properties" jsonb,
	"source" text NOT NULL,
	"weight" real DEFAULT 0.9 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"proposed_node" jsonb,
	"proposed_edge" jsonb,
	"evidence" text NOT NULL,
	"salience" real NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apple_sub" text,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub")
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_node_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_node_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_facts" ADD CONSTRAINT "pending_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_nudges" ADD CONSTRAINT "pending_nudges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_user_from_predicate_idx" ON "edges" USING btree ("user_id","from_node","predicate");--> statement-breakpoint
CREATE INDEX "edges_user_to_predicate_idx" ON "edges" USING btree ("user_id","to_node","predicate");--> statement-breakpoint
CREATE INDEX "events_user_timestamp_idx" ON "events" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "events_user_type_timestamp_idx" ON "events" USING btree ("user_id","type","timestamp");--> statement-breakpoint
CREATE INDEX "messages_user_timestamp_idx" ON "messages" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "nodes_user_type_idx" ON "nodes" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "nodes_user_label_idx" ON "nodes" USING btree ("user_id","label");--> statement-breakpoint
CREATE INDEX "pending_facts_user_status_idx" ON "pending_facts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "pending_nudges_user_scheduled_idx" ON "pending_nudges" USING btree ("user_id","scheduled_for");