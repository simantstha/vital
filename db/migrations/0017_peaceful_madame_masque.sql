CREATE TABLE "coach_recommendation_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"action" text NOT NULL,
	"plan_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_recommendation_interactions_action_check" CHECK ("coach_recommendation_interactions"."action" in ('accept', 'dismiss', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "daily_coach_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_day" text NOT NULL,
	"category" text NOT NULL,
	"action" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"material_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_coach_recommendations_category_check" CHECK ("daily_coach_recommendations"."category" in ('training', 'recovery', 'sleep', 'calibration'))
);
--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_recommendation_id_daily_coach_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."daily_coach_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_plan_item_id_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_coach_recommendations" ADD CONSTRAINT "daily_coach_recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_recommendation_interactions_user_action_idx" ON "coach_recommendation_interactions" USING btree ("user_id","action_id");--> statement-breakpoint
CREATE INDEX "coach_recommendation_interactions_recommendation_idx" ON "coach_recommendation_interactions" USING btree ("recommendation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_coach_recommendations_user_day_idx" ON "daily_coach_recommendations" USING btree ("user_id","local_day");