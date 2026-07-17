CREATE TABLE "food_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_food_id" text NOT NULL,
	"barcode" text,
	"name" text NOT NULL,
	"brand" text,
	"serving_desc" text,
	"serving_grams" real,
	"kcal_100g" real,
	"protein_100g" real,
	"carbs_100g" real,
	"fat_100g" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "food_cache_provider_food_idx" ON "food_cache" USING btree ("provider","provider_food_id");--> statement-breakpoint
CREATE INDEX "food_cache_barcode_idx" ON "food_cache" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "food_cache_name_idx" ON "food_cache" USING btree ("name");