# Vital v5 — "Am I on track?" (goal progress)

Date: 2026-10-06 · Author: orchestrating session (spec only; code delegated per AI_COMMON.md)

## Why
Four parallel reviews (PM, new customer, lifter/runner enthusiast, engineering
recon) agreed: the app answers "what happened today" well and "am I getting
where I want to go" not at all. The backend already computes most of the
answer (weight trend + signals, learned TDEE, weekly e1RM / volume) but
(a) there is no goal *target* to measure against (no target weight / date
columns; onboarding's `targetDate` is dropped) and (b) none of it reaches a
screen (`/api/workouts/summary` has zero iOS callers).

## Waves

### Wave 1 (parallel)
- [x] **A. Goal targets + progress engine (backend)** — additive migration
  (`target_weight_kg`, `target_date`, `goal_start_weight_kg`, `goal_started_at`,
  `weekly_sessions_target`); onboarding persists them; profile PATCH edits
  them; pure `lib/goalProgress.ts` + `GET /api/goal/progress` returning
  target / current / rate / safe band / ETA / verdict / ≤3 reasons /
  data sufficiency for all four goals. Never fabricate an ETA.
- [x] **B. Strength in the app (iOS)** — Strength section on Trends from
  `/api/workouts/summary` (e1RM per key lift, weekly volume, "+x kg in 4 wk" /
  "stalled 3 wk"); lift logger sheet with "repeat last session" posting to
  `/api/workouts/sets`; muscle Logs lists lift sessions.
- [x] **C. Declutter + trust** — "Vital noticed" below the goal hero; Today
  content clears the tab bar; fixture numbers agree across screens.

### Wave 2
- [x] Goal Progress card at top of Trends (+ detail sheet), one-line progress
  verdict in each Today hero, target weight in onboarding + Profile → Goal.
- [x] Weigh-in reachable for every goal, not only weight-loss.

### Wave 3
- [x] Weekly review (Sunday card + push): verdict, win / slip / one change.
- [x] Goal triggers as proactive nudges (plateau, too fast, stalled lift,
  low-protein streak, inactivity) — roadmap v4 4.1/4.2.
- [x] Goal-keyed daily brief prompt (finish v4 1.1/1.4; `lib/claude.ts` is still run-centric).
- [x] Account deletion + privacy policy (App Store blocker).
- [x] Plain-language explainers for HRV / readiness; weak "drivers" suppressed.

## Verification
Backend: `npm test`, `npx tsc --noEmit`, `npm run lint`. iOS: PR CI build +
tests + screenshot branch reviewed per scenario (new_user, weight_loss,
muscle, endurance, server_error).

## Status (2026-10-06, PR #256)
Waves 1–3 merged on `claude/nifty-babbage-sd8hzk` except the items still unticked.
Also shipped: `set_goal_target` coach tool, coach context + persona stay consistent with
the goal verdict, unit-aware goal text, onboarding no longer blocks on invalid optional targets.

Owner follow-ups:
- Replace `AppLinks.privacyPolicy` placeholder URL; review `docs/privacy-policy.md` (DRAFT).
- Run `npm run eval:prompts` (cases 10–12) with an API key — not run in cloud session.
- Sign in with Apple token revocation on delete needs an auth-code exchange + client secret (not built).

Next (wave 4):
- [x] Goal triggers as proactive nudges (plateau, too fast, stalled lift, low-protein streak, inactivity).
- [x] Plain-language explainers for HRV / readiness; suppress weak "drivers" (detectCrossLag thresholds).
- [x] Dedicated weekly-review notification toggle + inbox entry.
- [x] Second persona review pass on the new screenshots.

### Wave 5 (from persona review pass 2) — shipped
- [x] One definition per progress number (lift change "vs 4 weeks ago" shared by server + iOS with parity tests; labelled windows).
- [x] Weekly review advises a lighter week when ≥2 recovery flags; Trends headline counts lifts + weight.
- [x] Goal sheet: ETA vs target date in one line; muscle ETA + adherence; endurance sessions this week; set-target for every goal.
- [x] Endurance hero reconciles "Recover today" with a hard planned session.
- [x] Coach check-ins / weekly review notification toggles; nudges only 08:00–21:00 local (migration 0036).
- [x] Tile zero-delta reads "at your normal"; fixtures consistent across screens (cross-screen tests).

### Open / next
- [x] New-user Today: getting-started checklist first, incl. "Set your goal target".
- [ ] Today hero sparkline target line hidden when target is far below data range (caption only) — consider a compressed axis.
- [x] Third persona review (weight loss 5/5, muscle 4/5, PM 4/5) — blockers fixed in wave 6.

### Wave 6 (from persona review pass 3) — shipped
- [x] Log lift sheet: labelled Reps / Weight rows (steppers no longer overlap).
- [x] Endurance weekly distance target (migration 0037): "17.2 of 30 km this week" on hero, goal card, sheet; one labelled volume definition ("last 2 weeks vs the 2 before").
- [x] New users: one calibration count everywhere; empty weekly review hidden; "First review on Mon …".
- [x] Coach + daily brief use the same lift-change definition as the cards; weekly review "Next week" never repeats "Slip".
- [x] Goal pill states the outcome ("82 kg by ~Dec 6"); weight hero shows "→ Goal 76 kg"; HRV detail labels "30-day normal" vs range average.

### Polish backlog (non-blocking)
- [ ] Endurance Today goal line repeats the hero's km text — show the verdict reason instead.
- [ ] Mic FAB overlaps the last card at rest (scrolls clear) — consider auto-hiding the FAB on scroll.
- [ ] Today hero sparkline: compressed axis to draw the target line when it is far below the data.
- [ ] Sign in with Apple token revocation on account deletion.
