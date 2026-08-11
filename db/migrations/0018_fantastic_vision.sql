ALTER TABLE "coach_recommendation_interactions" DROP CONSTRAINT "coach_recommendation_interactions_action_check";--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" DROP CONSTRAINT "coach_recommendation_interactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" DROP CONSTRAINT "coach_recommendation_interactions_recommendation_id_daily_coach_recommendations_id_fk";
--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" DROP CONSTRAINT "coach_recommendation_interactions_plan_item_id_plan_items_id_fk";
--> statement-breakpoint
ALTER TABLE "daily_coach_recommendations" DROP CONSTRAINT "daily_coach_recommendations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD COLUMN "adjustment" jsonb;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_recommendation_id_daily_coach_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."daily_coach_recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_plan_item_id_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_coach_recommendations" ADD CONSTRAINT "daily_coach_recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ADD CONSTRAINT "coach_recommendation_interactions_action_check" CHECK ("coach_recommendation_interactions"."action" in ('accept', 'adjust', 'skip', 'complete', 'open_chat'));