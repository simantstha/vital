-- The migrator applies this file in a single transaction. A queued ACCESS
-- EXCLUSIVE lock (ENABLE ROW LEVEL SECURITY) would stall live queries behind
-- it, so fail fast: the release fails loudly and can simply be retried.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "baselines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "coach_recommendation_interactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_coach_recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "food_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "insight_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "morning_notification_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_nudges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sleep_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specialist_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whoop_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workout_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workout_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hardening: row level security is enabled on every public table with no
-- policies (the backend connects as the table owner, which bypasses RLS).
-- Also drop the client-role table/sequence grants. Guarded so clusters that
-- lack these roles (local dev) are unaffected.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END
$$;
