ALTER TABLE "notification_preferences" ADD COLUMN "meals_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "meal_breakfast_time_minutes" integer DEFAULT 480 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "meal_lunch_time_minutes" integer DEFAULT 765 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "meal_snack_time_minutes" integer DEFAULT 960 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "meal_dinner_time_minutes" integer DEFAULT 1170 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_meal_breakfast_time_check" CHECK ("notification_preferences"."meal_breakfast_time_minutes" between 0 and 1439);--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_meal_lunch_time_check" CHECK ("notification_preferences"."meal_lunch_time_minutes" between 0 and 1439);--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_meal_snack_time_check" CHECK ("notification_preferences"."meal_snack_time_minutes" between 0 and 1439);--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_meal_dinner_time_check" CHECK ("notification_preferences"."meal_dinner_time_minutes" between 0 and 1439);