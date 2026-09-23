CREATE TABLE "workout_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workout_id" uuid,
	"performed_at" timestamp with time zone NOT NULL,
	"local_day" text NOT NULL,
	"exercise" text NOT NULL,
	"exercise_display" text NOT NULL,
	"set_index" integer NOT NULL,
	"reps" integer NOT NULL,
	"load_kg" real,
	"rpe" real,
	"is_warmup" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workout_sets" ADD CONSTRAINT "workout_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workout_sets_user_exercise_performed_idx" ON "workout_sets" USING btree ("user_id","exercise","performed_at");--> statement-breakpoint
CREATE INDEX "workout_sets_user_session_idx" ON "workout_sets" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sets_session_set_idx" ON "workout_sets" USING btree ("session_id","set_index");