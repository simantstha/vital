# Vital UX spec v4: flows, states, motion

**Status:** DRAFT for owner review · 2026-09-22 · design spec only, no code.
**Implements:** `docs/roadmap-v4-general-coach.md` (1.2, 1.3, 1.5, Phase 2, 3.1, D3/D4). Built on the v3 tokens in `docs/redesign-v3-plan.md` §2 and the trust rules in `docs/audits/2026-08-31-product-audit.md`.
**Grounded in:** `main` @ `10221b0`, plus the unmerged harness on `feat/ios-screenshot-harness`.
**Research:** based on web-search summaries. The sandbox proxy blocked direct page fetches, so the sources were not read in full.

---

## 0. Summary

1. **Voice becomes a conversation.** You tap once and talk back and forth. The mic re-arms on its own, you can interrupt Vital, and you get feedback within 100 ms. End of speech to Vital's voice drops from about 4–6 s to a p50 of 1.8 s or less.
2. **The Coach Bar is how you reach the coach from every screen.** It uses iOS 26's native `tabViewBottomAccessory`, sits above the native tab bar, and never covers a composer. It replaces the Today FAB and the second voice pipeline.
3. **Every daily action takes 2 taps or fewer from any tab,** or one hold with voice.
4. **Today leads with the user's goal.** The plan comes second; recovery is demoted.
5. **Undo replaces confirm dialogs.** Every log commits immediately.

### 0.1 Where this spec disagrees with the roadmap

| Item | Challenge and reason |
|---|---|
| 2.1 speculative send | **Pair it with adaptive endpointing.** The fixed 1.8 s silence timer (`SpeechTranscriber.swift:57`) is the biggest wait. Speculative send alone saves about 1 of the 4–6 s. |
| 2.6 streaming STT | **Likely moot.** The iOS 26 target already has on-device `SpeechAnalyzer`, which streams with about 0.3–0.5 s to the first result ([ref](https://dev.to/simple_memo/ios-26s-speechanalyzer-on-a-live-mic-the-5-things-the-docs-dont-tell-you-2ng5)). Spend the effort on barge-in. |
| 3.1 IA | **Split it.** The Coach Bar works on today's 5 tabs (IA1), which delivers D3 without waiting for D5. |
| 1.2 weigh-in | **Don't build on `/api/weight-log`.** It writes a per-user JSON file with a 90-day trim (`lib/weightLog.ts`, audit #13). Use `weight_logged` events instead, and read the HealthKit `bodyMass` that's already backfilled before asking the user. |
| Theme.Haptics | **Carve out an exception for conversation-mode turn cues.** When the user isn't looking at the screen, the haptic is the only feedback. |
| Not in roadmap | `fly.toml:23` sets `min_machines_running = 0`, so the day's first voice turn pays for a cold start (Q3). |

---

## 1. Experience principles

| # | Principle | Test |
|---|---|---|
| P1 | **Acknowledge within 100 ms, then let motion confirm.** Every tap and every end of speech changes a pixel and fires a haptic within 100 ms. Nothing else moves. | Signpost: touch-down to first changed frame ≤ 100 ms. `repeatForever` only via `.ambient`. |
| P2 | **2 taps or fewer, or one voice gesture,** for a meal, weigh-in, workout, or question, from any tab. | §5 tap table, asserted in UI tests |
| P3 | **Talk like a person.** Auto re-arm, barge-in, never a silent wait. | Device QA: 5 turns with no taps and 2 barge-ins |
| P4 | **Never show a number you don't have.** | `new_user` PNGs contain no `0 ms`, `0h 0m`, `0 bpm`, or `0 kcal` |
| P5 | **No raw errors and no dead ends.** One human sentence plus one action. | `server_error` PNGs: no "HTTP"; every error has a button |
| P6 | **Nothing covers what you're typing or reading.** This is the lesson from the reverted pill bar. | Keyboard-up PNG: no overlay on the composer or the last message |
| P7 | **Goal-shaped.** What's above the fold on Today comes from `users.goal`. | 4 goal scenarios show 4 different heroes |
| P8 | **One voice (D4).** Specialists only appear as attribution. | No "Running Coach" or "Nutritionist" as a speaker, header, or button |

---

## 2. Information architecture

**Today:** 5 native tabs (Today, Coach, Trends, Logs, Profile). Voice has two pipelines: the Today FAB, which hides whenever a sheet opens, and the mic in the Coach composer. Logging only starts from Today's fuel strip.

### Option A (recommended): 3 tabs + Coach Bar + Coach sheet

```
┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│ Today content (scrolls)                │   │ Today content, still visible and       │
│                                        │   │ scrollable (background interaction on) │
│                                        │   ├────────────────────────────────────────┤
│                                        │   │                ───                     │
│                                        │   │  "log two eggs and toast for brea|"    │
│                                        │   │                ( ◉ )  orb, 72 pt       │
│                                        │   │              Listening                 │
├────────────────────────────────────────┤   │  [keyboard Type]           [xmark End] │
│ ( ✦ Ask Vital…          (+)  (mic) )   │   └────────────────────────────────────────┘
│   Today      History      Profile      │    Coach sheet, voice detent (.height 248);
└────────────────────────────────────────┘    drag up → .large = full CoachView chat
```

- **Tabs:** `Today` (`sun.max`), `History` (`calendar`; a segmented `Diary | Trends` view that merges LogsView and TrendsView), and `Profile` (`person`).
- **Coach Bar:** a new `CoachBar` in `.tabViewBottomAccessory`. Left to right: a 22 pt orb, placeholder text, `(+)` (opens the Log sheet), and a lime `mic.fill`. With `.tabBarMinimizeBehavior(.onScrollDown)` it collapses inline to orb, "Vital" and mic. The system insets content for the bar, so it never overlaps ([ref](https://www.hackingwithswift.com/quick-start/swiftui/how-to-add-a-tabview-accessory)).
- **Context-aware placeholder:** "Ask Vital…" / "Ask about Tue, Sep 16…" / "Ask about your HRV…", passed along through the existing `router.coachContext` (`RootTabView.swift:66`).
- **Coach sheet:** detents `[.height(248), .large]` with background interaction enabled up through the voice detent. `.large` is today's `CoachView`. Its composer sits inside a sheet that covers the tab bar, so P6 holds by construction.
- **Sheet closed mid-reply:** the Bar's orb keeps showing thinking or speaking, with the spoken sentence in its text slot, much like a Dynamic Island.

### Option B: 4 tabs (Today · Coach · History · Profile), with the Bar on the other tabs

| | A | B |
|---|---|---|
| Voice from anywhere | One control everywhere | Two mics (Bar + Coach composer) |
| Composer collisions | None | The Bar must be hidden on the Coach tab. Hiding the accessory per tab is **unverified** in the iOS 26 SDK, which is a risk |
| Chat as a place | Weaker (it's behind a gesture) | Strong (Messages-like) |
| Precedent | Cal AI (3 tabs + global add); Whoop "ask anywhere in the app" ([ref](https://www.whoop.com/us/en/thelocker/everything-whoop-launched-in-2025/)) | Chat-first apps |
| Harness churn | Tab labels change | Smaller |

**Recommendation:** A, delivered in two steps. IA1 puts the Bar on the current tabs. IA2 does the tab restructure after the owner reviews screenshots (D5).

**Outside the app (IA3):**
- An App Shortcut, "Talk to Vital" (works with Siri).
- A `ControlWidgetButton` for Control Center, the Lock Screen, and the Action Button, which opens the app into conversation mode. It uses an open-app intent because `AudioRecordingIntent` can't start recording from a cold background ([ref](https://developer.apple.com/documentation/AppIntents/AudioRecordingIntent)).
- A "Talk it through" action on push notifications.

---

## 3. Coach voice & conversation (roadmap 2.1–2.3)

### 3.1 Entry points

| Gesture | Result | Haptic |
|---|---|---|
| Tap `mic.fill` (Bar or composer) | **Conversation mode**, hands-free. The sheet opens at the voice detent, or stays at `.large` if it's already open. | `toggle` on touch-down |
| Hold the Bar mic for ≥ 300 ms | **Push-to-talk**, one turn. Release to send; slide left ≥ 80 pt to cancel (iMessage idiom). | `commit` at 300 ms · `turnEnd` on release · `selection` on cancel |
| Tap the Bar placeholder | Chat at `.large`, keyboard focused | none |
| Siri, Shortcut, Control, Action Button, or "Talk it through" | Conversation mode, with brief or nudge context when there is one | `toggle` |

### 3.2 State machine: one `CoachVoiceController` (2.2)

```
 IDLE ──tap──► LISTENING ──pause──► ENDPOINTING ──window elapses──► THINKING ──first audio──► SPEAKING
  ▲              ▲   ▲                   │ speech resumes                                  │      │ reply done
  │              │   └───────────────────┘                                                 │      ▼
  │              │◄──────────── INTERRUPTED ◄── user speech ≥ threshold ───────────────────┘   YOUR TURN (auto re-arm)
  │              └───────────────────────────────────────────────────────────────────────────────────┘
  └── End · swipe sheet down · 2 empty listens (10 s each) · app backgrounded > 10 s
  Any state ──► ERROR(kind) ──► recover (3.6) or IDLE
```

| State | Orb (72 pt in the sheet / 22 pt in the Bar) | Caption and label | Edge glow | Haptic | Sound |
|---|---|---|---|---|---|
| Idle | Lime disc with `mic.fill` | "Tap to talk · hold to dictate" | off | none | none |
| Listening | Scales 1.00–1.15 with mic level | Live words: volatile in `textSecondary`, settled in `textPrimary`. Label "Listening" | lime 35 %, static | `toggle` | `listen-start` (first turn only) |
| Endpointing | A ring traces 360°→0 across the window; talking again cancels it | unchanged | on | none | none |
| Thinking | 3 dots breathing | Tool status (`AssistantTurn.statusSummary`, e.g. "Checking your sleep…") or "Thinking…" | fades out over 250 ms | **`turnEnd`** | `thinking`, only after 700 ms without audio |
| Speaking | Follows TTS output level | The sentence being spoken; label "Vital" | off | none (the audio is the cue) | none |
| Interrupted | Snaps to Listening within 80 ms | Reply cut at the last spoken sentence, then "…" | on | **`interrupt`** | none |
| Your turn | Listening | "Your turn" for 1 s | on | **`yourTurn`** | soft tick |
| Ended | Orb animates back into the Bar | System row "Voice · 3 min" | off | `toggle` | none |

Borrowed: voice in the chat with a live transcript (ChatGPT, [ref](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect)) and the edge glow as the listening signal (Siri, [ref](https://www.slashgear.com/1865686/iphone-glowing-around-edges-reason/)). The new `CoachOrb` replaces the FAB's `PulseRing`.

### 3.3 Endpointing (the biggest single latency win)

Replace the fixed 1.8 s timer with a window that starts at the last partial result:

| Utterance ends with | Window |
|---|---|
| A complete clause (the recognizer added punctuation) | 600 ms |
| Anything else (default) | 800 ms |
| A trailing filler or conjunction ("um", "and", "so", "but") | 1,200 ms |
| A dangling number or unit ("3 by 5 at…", "182 point…") | 1,000 ms |

In push-to-talk, releasing ends the turn. A conversation-mode turn is capped at 60 s; push-to-talk keeps today's 30 s.

### 3.4 Latency budget

"Today" figures are estimates from reading the code. V1 instruments them.

| Step | Today (est.) | Target p50 | Technique |
|---|---|---|---|
| Tap → mic live | 250–500 ms. The `.record` category switch and engine start happen on tap (`SpeechTranscriber.swift:118`). | ≤ 120 ms | Pre-warm one `.playAndRecord`/`.voiceChat` session and the engine when the Bar or sheet appears; start on touch-down |
| End of speech → turn closed | 1,800 ms, fixed | 700 ms | Adaptive window (§3.3) with a visible ring |
| Turn closed → text ready | 0.8–2 s, awaiting the `/api/stt` (Scribe) upload (`CoachViewModel.swift:417`) | **0 ms on the critical path** | **Speculative send** of the on-device final text. Scribe runs in parallel and replaces the text only if it differs materially (normalized edit distance > 0.15, or any number differs). |
| Request → first token | 1–2 s without tools, 1–3 s more per tool, plus cold start | ≤ 900 ms (no tools) | Warm the connection when the sheet opens. `voice: true` tells `/api/coach` to use a voice style: 1–3 sentences, no markdown, and a **spoken acknowledgment of 8 words or fewer before any tool call** ("Let me look at your sleep.") |
| First token → first audio | A full sentence plus the `/api/tts` round trip, about 300–600 ms | ≤ 350 ms | **First-clause flush:** for the first sentence only, hand it to TTS at the first `,` `;` or `:` once there are ≥ 6 words. `eleven_flash_v2_5` is already in use. |
| Any gap with no cue | Unbounded | **never > 700 ms** | Thinking earcon, tool caption, orb breathing |
| **End of speech → Vital audible** | **≈ 4–6 s** | **p50 ≤ 1.8 s · p95 ≤ 3.0 s** | |

Speech-to-speech systems target under 800 ms ([ref](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it)). A cascaded pipeline with tools can't match that, so the bar is that a turn never *feels* dead. That's why P1 and the 700 ms rule are hard requirements.

**Backend dependency:** `runCoach` saves the user message with no idempotency key (see the `ErrorCard` doc). Add a `clientTurnId` upsert so that Scribe corrections and **Retry** are safe.

### 3.5 Barge-in (2.3)

- **One session for the whole conversation:** `.playAndRecord` / `.voiceChat` / `.defaultToSpeaker` / `.allowBluetoothHFP`, with engine voice processing for echo cancellation. Also set `setAllowHapticsAndSystemSoundsDuringRecording(true)`, or iOS mutes every haptic while the mic is live. Today the code switches between `.record` and `.playback`, which makes barge-in impossible.
- **Trigger:** on headphones, ≥ 250 ms of speech plus 1 recognized word. On the speaker, ≥ 400 ms plus 2 words, with a 600 ms echo gate after each sentence; field reports say 300 ms is too short ([ref](https://barock.dev/2026/04/22/why-your-ios-voice-agent-still-hears-itself)).
- **On trigger:** fade TTS out over 80 ms, clear the queue and pending fetches, call `stopGenerating`, cut the turn at the last sentence spoken, and go back to Listening. Buffered audio has to be dropped aggressively ([Gemini Live](https://dev.to/ifynx_studio/gemini-38-live-designing-voice-agents-that-think-without-breaking-the-conversation-3cgd)).

### 3.6 Voice errors

| Case | Copy | Action |
|---|---|---|
| Mic permission not yet asked | Explainer before the system prompt: "Vital only listens while the orb is lit." | [Continue] |
| Denied (inline; replaces today's alert) | `mic.slash.fill` "Your mic is off for Vital." | [Open Settings] [Type instead] |
| Offline | `wifi.slash` "You're offline. Voice needs a connection." | [Type instead]; resumes automatically when back online |
| Empty transcript | "Didn't catch that. Go ahead." | Keeps listening; nothing is sent |
| Noisy room (speech but ≤ 1 word for 6 s) | `ear.trianglebadge.exclamationmark` "It's loud here. Hold the mic to talk." | Switches to push-to-talk |
| Coach failed | `ErrorCard` "Couldn't reach Vital. Your message is saved." | [Retry] (safe because of `clientTurnId`) |
| Phone call, Siri, headphones unplugged | "Paused" | Tap the orb to resume |

### 3.7 Voice in the transcript

- **User voice turn:** a normal bubble with a `waveform` glyph (11 pt, `textTertiary`). If Scribe corrects the text, the bubble cross-fades over 150 ms, with no marker.
- **Speaking at `.large`:** the current sentence gets an `accentSoft` highlight, one sentence at a time.
- **Interrupted reply:** truncated, then "…", then "Interrupted" (`labelSmall`/`textTertiary`).
- **`log_*` tool results:** render a `LogReceiptCard` (§5.5). Vital says one sentence: "Logged two eggs and toast, about 390 calories."

### 3.8 Accessibility

- **VoiceOver:** defaults to push-to-talk, because hands-free listening would compete with VoiceOver's own speech. Post an `AccessibilityNotification.Announcement` only when the state changes. The orb's label is "Voice conversation, listening. Double-tap to end."
- **Reduce Motion:** the orb doesn't react to level, the glow is static, and transitions are cross-fades. The endpoint ring stays, because it carries information.
- **Captions** are always on. New components use `relativeTo:` fonts.

---

## 4. Today, goal-shaped (roadmap 1.5)

**Order:**
1. Header (date, greeting, streak chip, bell)
2. **Morning brief card**, until 11:00 or dismissed
3. **Goal hero**
4. **Plan timeline**
5. Secondary row
6. Caution banners

Components:
- **Reused:** `VitalCard` wraps the hero, the brief uses `CoachBubble` styling, and `MetricTile` moves down to a compact row.
- **`FuelStripView`:** shown for every goal except weight_loss, where the hero already covers calories.
- **Plan rows:** status changes animate (§6) and rows never reorder. Meal "Log" opens the Log sheet on that meal's slot. Workout rows get "Start" and "Log as done".

### 4.1 Hero per goal

```
WEIGHT_LOSS                                   MUSCLE
┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
│ 1,240 kcal left         Trend 182.4 lb│     │ Push day · 5 exercises · ~55 min     │
│ ████████░░░░ 610 of 1,850  −0.6 lb/wk │     │ Last (Mon) Bench 3×5 @ 185 lb        │
│ Protein 64 / 150 g      ╲╲_╲_ (14 d)  │     │ [ Start push day ]    [ Log as done ]│
│ [scalemass Weigh in · 181.8?] [camera]│     │ Protein 112 / 160 g  ███████░░░      │
└──────────────────────────────────────┘     │ This week ● ● ○ ○  2 of 4 sessions   │
                                              └──────────────────────────────────────┘
ENDURANCE                                     MAINTENANCE (general)
┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
│ Ready to push                         │     │  ◔ 4/5   Active days this week       │
│ HRV +8% · Sleep 7h40 · RHR −2 vs norm │     │          Move ✓   Eat ○   Sleep ✓    │
│ Today: Tempo · 8 km                   │     │ A 20-min walk closes today.          │
│ Week ████████░░░░ 24 of 40 km         │     │ [ Log a meal ]                       │
└──────────────────────────────────────┘     └──────────────────────────────────────┘
```

| Goal | Hero | Honesty rule (P4) |
|---|---|---|
| weight_loss | kcal left (`numericHero 40`), **smoothed** trend and weekly rate, protein, weigh-in chip, camera | The trend needs 3 weigh-ins over ≥ 5 days. Until then: "Trend appears after 3 weigh-ins · 1 of 3". The headline is the trend, not the scale reading ([MacroFactor](https://help.macrofactorapp.com/en/articles/21-weight-trend)). |
| muscle | Today's session with last-time values, protein, sessions this week | No session planned: "Rest day. Protein still counts." |
| endurance | A readiness **word** from the existing gated verdicts (no invented score), today's session, weekly volume in any sport | Until baselines are calibrated: "Calibrating · day 5 of 14" |
| general | Active-days ring (default target 5), Move/Eat/Sleep checks | A check is only filled when the data exists; otherwise it shows ○ |

### 4.2 New user and error

```
NEW USER (any goal)                           ERROR (server_error)
┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
│ Let's get your baseline               │     │ ⚠ Couldn't load today                │
│ Day 1 of 14  ▓░░░░░░░░░░░░░           │     │ Something went wrong on our end.     │
│ ✓ Health connected                    │     │ Try again shortly.        [↻ Retry]  │
│ ○ Log your first meal        [ Log ]  │     └──────────────────────────────────────┘
│ ○ Weigh in (or first workout)[ Add ]  │     Header + Coach Bar still render;
│ ○ Say hi to Vital            [ mic ]  │     no hero, plan, tiles, or zeros.
└──────────────────────────────────────┘
```

- **New user:** no tiles and no fuel-strip numbers until data exists. The third row depends on the goal: weigh-in for weight_loss/general, first workout for muscle/endurance. Once the checklist is complete, the goal hero replaces it (`hero-swap`).
- **Loading:** static skeletons shaped like the hero (148 pt), 3 plan rows, and the compact row.

### 4.3 Morning brief card

- **Layout:** an `accentSoft` card: a 22 pt orb, "Vital · 7:05", at most 2 sentences, **one** primary chip ("Log breakfast" / "Start push day"), and `[mic Talk it through]`.
- **Dismissal:** tap `xmark` or swipe, and it stays gone for the day. After 11:00 it collapses into a one-line `CoachBubble`.
- **Empty brief:** render nothing (the existing `CoachBubble.isEmpty` guard).

---

## 5. Logging in ≤ 2 taps (roadmap 1.2, 1.3)

### 5.1 Tap counts

| Action | Today (code) | Spec | Path |
|---|---|---|---|
| Recent meal | 2, from Today only | **2, any tab** | `(+)` → recent chip |
| Photo meal | 5, and the photo library only | **2** | `(+)` → shutter → auto-logged with Undo/Edit |
| Barcode | 4–5 | **1–2** | `(+)` → aim (auto-detects) → 1 serving logged |
| Describe a meal | ~4 plus the STT wait | **1 gesture** | Hold the Bar mic: "two eggs and toast" |
| Weigh-in | impossible | **1** with a scale reading / **2** manual | Hero chip → confirm |
| Repeat a workout | impossible | **1** on Today / **2** elsewhere | "Log as done" / `(+)` → "Push day again" |
| Workout by voice | impossible | **1 gesture** | "3 by 5 squat at 225" |
| Ask the coach | 2 | **1** | Bar mic |

### 5.2 Log sheet

The Log sheet replaces DietSheet as the place logging starts. DietSheet's content stays, for editing.

```
┌────────────────────────────────────────┐
│                 ───                    │
│ ┌────────────────────────────────────┐ │  Live DataScanner: barcodes auto-detect
│ │         camera viewfinder          │ │  (box snaps on detect); shutter = meal
│ │              ( ◯ )                 │ │  photo, Cal AI-style
│ └────────────────────────────────────┘ │
│ Lunch ▾                                │  slot inferred from time
│ [Chicken bowl 620] [Greek yogurt 180] →│  recents: 1 tap = logged
│ [scalemass Weigh in] [dumbbell Push day again] [magnifyingglass] │
└────────────────────────────────────────┘   detents [.medium, .large]
```

- **One viewfinder, no mode switch.** `DataScannerViewController` (VisionKit is already imported) handles barcodes and photo capture; the simulator falls back to `PhotosPicker`. Borrowed: Cal AI's "snap, review, save" ([ref](https://calaiscanner.com/)) and MFP's single place for scan, voice, and search ([ref](https://blog.myfitnesspal.com/meal-scan/)).
- **Photo flow:** the shutter flashes (120 ms, `commit`) and the sheet closes. A pending row, "Analyzing your meal…", appears. When the estimate arrives the row fills in (`log-confirm`) and a toast shows "Logged Chicken bowl · ~620 kcal [Edit] [Undo]". If confidence is low or the estimate is over 1,200 kcal, a confirm card with a portion stepper appears instead.
- **Search** (5 taps) remains the fallback.

### 5.3 Weigh-in (1.2)

- **If HealthKit has a scale reading today:** the chip says "181.2 lb from your scale ✓". Tapping it confirms (1 tap, `success`), and the new trend point animates in.
- **Manual:** the chip says "Weigh in · 181.8?" using the last value.
  - Tapping opens a `.height(300)` sheet with the value in `numericHero(56)`, a 0.1-step ruler (`selection`, at most once per 50 ms), and **[Log 181.8 lb]**. That's 2 taps.
  - Units follow `UnitPreference`. The first-ever weigh-in opens with the keypad focused and nothing pre-filled.
- **After logging:** the trend and rate roll to their new values (`.numericText`), and a toast shows "Logged 181.8 lb · trend 182.3 (−0.5/wk)".
- **Voice:** "182 this morning" goes to `log_weight`.

### 5.4 Workout (1.3)

"Start push day" opens a logger pre-filled with last session's sets as **ghost values**. Users credit this Hevy/Strong pattern with making logging fast ([ref](https://www.hevyapp.com/features/track-exercises/)).

```
┌────────────────────────────────────────┐
│ Push day               12:04  [Finish] │
│ Bench press            prev 185 × 5    │
│  1   185 lb × 5                 [✓]    │   ✓ = logged at the shown values
│  2   185 lb × 5                 [✓]    │   tap a number = inline stepper
│  3   185 × 5  (ghost)           [ ]    │   (±5 lb / ±1 rep; long-press ±1 lb)
│  + Add set                             │
└────────────────────────────────────────┘
```

- **"Log as done":** logs last session's sets as they are, with Undo.
- **Voice:** "3 by 5 squat at 225" goes to `log_workout`, which normalizes aliases and uses the unit preference. If it's ambiguous, Vital asks **one** question with 2 chips ("Back squat" / "Front squat").
- **No history yet:** templates (Full body, Push, Pull, Legs, Custom), plus "Or just tell Vital what you did."
- **HealthKit workouts:** still auto-import. A matching plan row completes silently and shows "Synced from Apple Watch".

### 5.5 Confirm/undo pattern

- **Optimistic commit:** the UI updates on tap and fires `success`. Logging never asks "Are you sure?"
- **`ActionToast` (new):** the existing `.toast` is top-center and doesn't accept taps, so it stays for plain confirmations.
  - Layout: a bottom pill 12 pt above the Coach Bar with `checkmark.circle.fill`, the item name, and [Undo] [Edit].
  - Timing: 5 s, paused while touched; 10 s under VoiceOver.
  - Behavior: swipe down to dismiss; a newer toast replaces the current one.
- **Undo:** reverses the animation, fires `toggle`, and shows "Removed".
- **Server failure after commit:** revert and show "Couldn't save that. [Retry]", with copy from `UserFacingError`.
- **`LogReceiptCard`:** appears in the Coach transcript for every `log_*` tool result: icon, name, key number, and [Undo] [Edit]. Undo stays available for 10 minutes.

---

## 6. Motion & haptics system

These existing rules stay: spring damping of 0.8, nothing non-ambient longer than 0.5 s, and loops only via `.ambient`.

| Motion | Used for | Token (✚ = new) | Reduce Motion |
|---|---|---|---|
| press | Every tappable card | `VitalButtonStyle` / `micro` 0.15 s | Opacity only |
| log-confirm | Number rolls, checkmark draw | `numeric` + `settle` 0.4 s | Cross-fade |
| card-insert | Receipts, brief, pending rows | `.motionTransition(.card)` + `settle` | Fade |
| row-status | Plan status change, dims to 60 % | `standard` 0.25 s | Fade |
| toast | ActionToast in and out | `snap` / `exit` | Fade |
| stream-reveal | Coach text | No per-token animation; new blocks use `appear` 0.25 s (after 2.5 memoization) | None |
| orb-level | Listening and speaking | ✚ `levelAttack` 60 ms / `levelRelease` 150 ms via `TimelineView` | Static |
| orb-breathe | Thinking | `breathe` via `.ambient` | Static dots |
| endpoint-ring | Endpointing | ✚ `Motion.endpoint(d)` = `.linear(d)`, d = 0.6–1.2 s. Linear because it's a countdown. | Kept (it carries information) |
| orb-dock | Orb moving between Bar and sheet | `matchedGeometryEffect` + `arrive` 0.5 s | Fade |
| hero-swap / chart-point | Checklist → hero; new weight point | `standard` + `.card` / `settle` | Fade |

| Haptic event | Token |
|---|---|
| Mic touch-down, end of conversation, Undo | `toggle` |
| Push-to-talk engaged, log/send/shutter | `commit` |
| User-initiated log confirmed (not HealthKit auto-imports) | `success` |
| Ruler/stepper tick, chip select (at most once per 50 ms) | `selection` |
| ✚ Turn captured (Listening → Thinking), **conversation-mode exception** | `turnEnd` = `.impact(weight: .light, intensity: 0.6)` |
| ✚ Mic re-armed, **exception** | `yourTurn` = `.selection` |
| ✚ Barge-in accepted, **exception** | `interrupt` = `.impact(weight: .light, intensity: 0.4)` |
| Errors, data loads, stream tokens, background syncs | none (rule unchanged) |

- **Theme doc comment:** amend it to allow turn-taking cues in conversation mode, used without looking at the screen. These require `setAllowHapticsAndSystemSoundsDuringRecording(true)`.
- **Earcons (new):** 3 sounds, each 60–180 ms at −18 dBFS: `listen-start`, `turn-captured`, and `thinking`. They're on by default, can be turned off with a "Voice sounds" toggle in Profile → Notifications, and only play in conversation mode.

---

## 7. Proactive coach surfaces

| Surface | Trigger | Where the tap lands (today → spec) |
|---|---|---|
| Morning brief | Existing slot | `MorningBriefView` sheet → **Today, with the brief card expanded** and "Talk it through" |
| Goal nudges (4.2): deficit slipping 3 days, protein low 3 days, lift stalled 3 weeks, missed key session, 4 inactive days | Insight engine | `NudgeDetailView` → **Coach sheet `.large`**, with the nudge as Vital's latest message and 2 chips ("Adjust my plan" / "Not now") |
| Workout / sleep analysis | Existing | Keep the sheets. The Bar context becomes "Ask about this run…" |
| Weekly check-in (4.3) | Sundays, after ≥ 14 days of data | Coach sheet with a card: "Your trend says you burn ~2,350. Set target to 1,850?" [Apply] [Keep] |
| Day in review (optional; Whoop's Daily Outlook / Day in Review split) | 20:30, only if something was logged that day | Today, with one line and tomorrow's first action |
| Meal / weigh-in reminders | `ReminderScheduler` | **Log sheet with the camera live** / weigh-in sheet. Push action: "Log now" |

- **Caps:** at most 2 pushes a day including the brief, and at most 1 nudge. None during the sleep window (`SleepGoal`, otherwise 21:30–07:00) or within 90 minutes of an in-app session. A nudge type dismissed twice is muted for 14 days. No deficit or weight nudges for users flagged by the 0.3 safety block.
- **Copy:** second person, one number at most, one verb, no guilt ("Still time for a 20-min walk", never "You missed…").
- **D4 attribution:** Vital is always the speaker. When a specialist contributed, a footer appears (`labelSmall`/`textTertiary`): `fork.knife` "Checked with your nutritionist" or `dumbbell` "Checked with your trainer". Tapping it opens a one-line popover; the footer is never spoken. Delete the handoff cards, "Stay with Running Coach" (`CoachView.swift:307,919`), the persona header switch, and `specialistEdgeGlow`.

---

## 8. Empty / loading / error states

- **Skeletons, never spinners.** A skeleton appears only after 250 ms (so it doesn't flash), stays at least 400 ms, and matches the real layout's geometry. Skeletons are static (the existing `SkeletonView`/`SkeletonBlock`).
- **Refresh:** pull-to-refresh keeps the current content on screen.
- **Error copy** comes from `UserFacingError`.

| Screen | Loading | Empty | Error / offline |
|---|---|---|---|
| Today | Hero, plan, and row skeletons | New-user checklist (§4.2) | A single `ErrorCard`, "Couldn't load today" [Retry]; offline uses "You're offline — check your connection and try again." |
| Coach chat | Typing indicator while restoring | Opener plus 3 **goal** chips. weight_loss: "What should I eat tonight?" · muscle: "Plan my next session" · endurance: "How hard should I go today?" · general: "How am I doing this week?" | ErrorCard in the transcript [Retry]. Offline placeholder: "Offline. Vital will be back when you are." |
| Log sheet | 3 chip skeletons | "Your meals will show up here to log again in one tap." | Hide the chips; the camera still works. Camera denied: "Camera's off for Vital." [Open Settings] [Search instead] |
| Weigh-in / workout | Local / skeleton rows | Keypad, no pre-fill / templates plus "tell Vital" | Revert, then toast [Retry] |
| History · Diary | Day skeleton | "Nothing logged on Tue. [+ Add]" | "Couldn't load your diary" [Retry] |
| History · Trends | 6 `SkeletonView` tiles | Calibrating banner (existing) | Existing ErrorCards, never next to empty-state copy |

---

## 9. Screenshot acceptance criteria

**The harness today** captures `today`, `dietSheet`, `coach`, `trends`, `logs`, and `profile` for `new_user`, `weight_loss`, `muscle`, `endurance`, and `server_error`, plus `onboarding`, in light and dark.

**Additions:**
- A `maintenance` scenario (goal = `general`).
- Screens: `logSheet`, `weighIn`, `workout`, and `coachKeyboard`.
- A launch argument, `-VitalVoiceState listening|thinking|speaking|denied`, which produces `voice_*` PNGs.
- After IA2: `history_diary` and `history_trends`.

**Global checks (every PNG):**
- **G1** No "HTTP", "Error Domain", "nil", or "null".
- **G2** No fabricated zeros; show "—" or an explanation instead.
- **G3** Nothing overlaps the composer, the last message, the tab bar, or the Coach Bar.
- **G4** Dark mode: lime text only in `accentContent`, and cards have a 0.5 pt border. Light mode: no lime text on white.
- **G5** No truncated hero numbers and no clipped text.
- **G6** Outside `endurance`, no "run", "marathon", or "Running Coach".
- **G7** At most one lime-filled primary action per card.

| Screen | new_user | weight_loss | muscle | endurance | maintenance | server_error |
|---|---|---|---|---|---|---|
| today | Checklist hero, "Day N of 14", **no tiles** | kcal hero, trend or "1 of 3", weigh-in chip, no fuel strip | Session hero with last values, protein bar | Readiness word, session, week volume | Ring, Move/Eat/Sleep | One ErrorCard + header + Bar only |
| logSheet | Viewfinder, empty-recents copy | Slot chips + "Weigh in" | "Push day again" chip | Recent chips | Recent chips | Viewfinder, no chips, no error text |
| weighIn | Keypad, no pre-fill | Last value, correct unit | n/a | n/a | Pre-filled | n/a |
| workout | Templates + "tell Vital" | n/a | Ghost values; ✓ targets ≥ 44 pt | "Synced from Apple Watch" label | n/a | n/a |
| coach | Opener + goal chips | Non-running chips; receipts show Undo | same | Endurance chip | same | Fallback greeting; composer usable |
| coachKeyboard (all) | Composer fully above the keyboard; last message visible | | | | | |
| voice_* (all) | Orb, label, and caption match the state; glow only while listening; denied shows 2 buttons | | | | | |
| history / trends / logs | Calibrating banner; "Nothing logged" | Weight card first | Volume card first | Distance/load first | Consistency first | ErrorCards only |
| profile | Goal shown as a label ("Build muscle"), never an id | same | same | same | same | ErrorCard [Retry] |
| onboarding | Goal step: 4 goals, general-purpose copy; coach intro | | | | | |

---

## 10. Delivery slicing

Each PR can ship on its own and takes about 2 days or less. Each includes screenshot proof and flags anything that needs device QA. Tiers follow `AI_COMMON.md`. The V track and the L/W track touch different files and can run in parallel.

| # | PR | Roadmap | Tier · size | Depends on |
|---|---|---|---|---|
| H1 | Harness: `maintenance` scenario, `-VitalVoiceState`, new screens | 0.2 | Sonnet · S | Harness merged |
| V1 | Voice telemetry (signposts, DEBUG HUD, `voice_turn_timing`) + **adaptive endpointing** | 2.1 | Sonnet · S | none |
| V2 | `CoachVoiceController`; FAB and Coach mic both use it; FAB pipeline deleted | 2.2 | Sonnet · M | none |
| V3 | One `.playAndRecord`/`.voiceChat` session, pre-warm, touch-down start, haptics during recording, new Haptics tokens | 2.4 | Sonnet · S | V2 |
| V4 | **Speculative send** (SpeechAnalyzer) + `clientTurnId` upsert + Scribe as correction | 2.1 | Sonnet · M | V2 |
| V5 | Conversation mode: state machine, `CoachOrb`, voice detent, auto re-arm, §3.6 errors | 2.3 | Sonnet · M | V3 |
| V6 | `voice: true` server style (short replies, acknowledgment before tools) + first-clause flush + thinking earcon | 2.1 | Sonnet · S | V1 |
| IA1 | **Coach Bar** on the current 5 tabs; FAB removed | 3.1 (part) | Sonnet · M | V5 |
| V7 | **Barge-in** (echo cancellation, per-route thresholds, interrupted turns). Needs device QA. | 2.3 | Sonnet · M | V5 |
| L1 | `ActionToast` + `LogReceiptCard` | 2.4 | Haiku · S | none |
| L2 | Weigh-in backend: `weight_logged` events, `log_weight`, smoothed-trend endpoint, file store retired (additive migration) | 1.2 | Sonnet · M | none |
| L3 | Weigh-in iOS: hero chip, sheet, HealthKit scale confirm | 1.2 | Sonnet · M | L1, L2 |
| L4 | Log sheet: unified viewfinder, recent chips, pending photo rows; `(+)` on the fuel strip until IA1 ships | 1.x | Sonnet · M | L1 |
| L5 | Coach receipts with Undo for `log_*` tools | 1.2/1.3 | Sonnet · S | L1, L2 |
| W1 | `workout_sets` schema + `log_workout` + "3 by 5 at 225" parsing | 1.3 | Sonnet · M | none |
| W2 | Workout iOS: "Log as done", ghost-value logger, templates | 1.3 | Sonnet · M | W1, L1 |
| T1 | Hero: weight_loss, general, new-user checklist; tiles demoted | 1.5 | Sonnet · M | L3, H1 |
| T2 | Hero: muscle, endurance | 1.5 | Sonnet · M | W2 |
| T3 | Brief card; push → Today; nudge → Coach sheet | 1.4/4.2 | Sonnet · S | 1.4 backend |
| P1 | Specialist attribution footer; handoff UI and copy removed | 5.3/D4/1.1 | Haiku · S | none |
| IA2 | 3 tabs: History (Diary/Trends); Coach becomes the sheet; `ScreenshotTests` updated | 3.1 | Sonnet · M | IA1, **D5** |
| IA3 | App Shortcut, Control/Action Button control, "Talk it through" push action | 3.1 | Sonnet · S | V5 |

**Critical path to "voice feels good":** V1 → V2 → V3 → V4 → V5 → IA1 → V7, about 9–11 agent-days. **Logging** runs in parallel: L1 → L2 → L3/L4/L5, and W1 → W2.

---

## 11. Open questions for the owner

> **Owner decisions (2026-09-22):** Q1 — approve IA1 now (Coach Bar on current tabs), decide A/B from IA2 screenshots · Q2 — auto-log + 5 s Undo, confirm only on low confidence or > 1,200 kcal · Q3 — yes, `min_machines_running = 1` · Q4 — on-device first, Scribe as background correction, drop after 2 weeks if within 2 WER points · Q5 — not asked; recommendation (no background voice in v1) stands.

1. **D5: Option A (3 tabs + Coach sheet) or Option B (keep a Coach tab)?** *Rec:* approve IA1 now, since the Bar works under either option. Choose A or B from IA2 screenshots after a week of use. I expect A.
2. **Auto-log with Undo, or confirm first, for photo and voice meal estimates?** *Rec:* auto-log with a 5 s Undo and Edit. Show a confirm card only when confidence is low or the estimate is over 1,200 kcal.
3. **Keep one Fly machine warm (`min_machines_running = 1`)?** *Rec:* yes. Otherwise the first voice turn and the brief each day pay for a cold start. V1 telemetry will measure the actual cost.
4. **Drop cloud STT (Scribe) once SpeechAnalyzer is measured?** *Rec:* keep Scribe as a background correction for 2 weeks. If on-device accuracy on your own speech is within 2 points of word error rate, drop it: one fewer network hop and one fewer cost.
5. **Keep voice running when the screen locks or you leave the app** (Live Activity + background audio)? *Rec:* not in v1. End the conversation 10 s after backgrounding and revisit with usage data.

---

### Sources

- **Cal AI:** <https://calaiscanner.com/>
- **MyFitnessPal:** <https://support.myfitnesspal.com/hc/en-us/articles/39985611667341-Introducing-the-brand-new-Today-tab> · <https://blog.myfitnesspal.com/meal-scan/> · <https://support.myfitnesspal.com/hc/en-us/articles/30332897072269-Voice-Logging>
- **Whoop 2025:** <https://www.whoop.com/us/en/thelocker/everything-whoop-launched-in-2025/>
- **MacroFactor:** <https://help.macrofactorapp.com/en/articles/21-weight-trend> · <https://help.macrofactorapp.com/en/articles/109-how-frequently-do-i-need-to-log-my-weight-for-the-expenditure-algorithm-and-weekly-coaching-updates>
- **Hevy:** <https://www.hevyapp.com/features/track-exercises/>
- **Apple Workout Buddy** (pep-talk tone for the brief): <https://www.apple.com/newsroom/2025/06/watchos-26-delivers-more-personalized-ways-to-stay-active-and-connected/>
- **ChatGPT voice:** <https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpts-new-voice-integration-feels-like-the-missing-piece-in-ai-chat-ive-tried-it-and-its-almost-perfect> · <https://help.openai.com/en/articles/9617425-advanced-voice-mode-faq>
- **Gemini Live:** <https://dev.to/ifynx_studio/gemini-38-live-designing-voice-agents-that-think-without-breaking-the-conversation-3cgd>
- **Siri glow:** <https://www.slashgear.com/1865686/iphone-glowing-around-edges-reason/>
- **Voice latency:** <https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it> · <https://futureagi.com/blog/how-to-measure-voice-ai-latency-2026/>
- **iOS echo cancellation / barge-in:** <https://barock.dev/2026/04/22/why-your-ios-voice-agent-still-hears-itself>
- **SpeechAnalyzer:** <https://dev.to/simple_memo/ios-26s-speechanalyzer-on-a-live-mic-the-5-things-the-docs-dont-tell-you-2ng5>
- **`tabViewBottomAccessory`:** <https://www.hackingwithswift.com/quick-start/swiftui/how-to-add-a-tabview-accessory>
- **`AudioRecordingIntent`:** <https://developer.apple.com/documentation/AppIntents/AudioRecordingIntent>
