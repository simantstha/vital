# Vital

A personal ambient health dashboard + AI coach. Combines Whoop recovery data, Strava training load, and MyFitnessPal nutrition into a fullscreen kiosk display, with a Telegram bot you can message from anywhere.

![Dashboard](https://github.com/simantstha/vital/raw/main/public/screenshot.png)

---

## What it does

**Dashboard (1920×1080 kiosk)**
- Recovery, HRV, sleep, and strain from Whoop
- Weekly run/walk/gym charts from Strava
- AI-generated daily brief: workout prescription + 4-meal nutrition plan
- Meals adjust in real time based on what you actually ate (via the bot)

**Telegram bot (@VayamBot)**
- Ask your coach anything: *"Should I run today?"*, *"What should I eat before my long run?"*
- Send a meal photo → Claude Vision identifies food and estimates macros
- Send a product barcode photo → looks up Open Food Facts + calculates macros for your portion
- Log weight: *"log weight 174"* → stored, used to validate calorie targets over time
- Morning brief delivered automatically when your Whoop sleep session closes

---

## Prerequisites

- Node.js 20+
- Accounts needed: [Whoop](https://developer.whoop.com), [Strava](https://www.strava.com/settings/api), [Anthropic](https://console.anthropic.com), [MyFitnessPal](https://www.myfitnesspal.com), [Telegram](https://t.me/BotFather)

---

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env.local`

```bash
cp .env.example .env.local   # or create it manually — see below
```

Full `.env.local` template:

```env
# Whoop
WHOOP_CLIENT_ID=
WHOOP_CLIENT_SECRET=
WHOOP_REFRESH_TOKEN=
WHOOP_REDIRECT_URI=http://localhost:3000/api/whoop/callback
WHOOP_WEBHOOK_SECRET=        # set after registering Whoop webhook (optional for local)

# Strava
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
STRAVA_REDIRECT_URI=http://localhost:3000/api/strava/callback

# Anthropic
ANTHROPIC_API_KEY=

# MyFitnessPal
MFP_USERNAME=
MFP_PASSWORD=

# Telegram
TELEGRAM_BOT_TOKEN=          # from @BotFather
TELEGRAM_WEBHOOK_SECRET=     # any random string, e.g. "mylocalsecret123"
```

### 3. Get API credentials

#### Whoop
1. Go to [developer.whoop.com](https://developer.whoop.com) → create an app
2. Set redirect URI to `http://localhost:3000/api/whoop/callback`
3. Copy Client ID + Secret into `.env.local`
4. Visit `http://localhost:3000/api/whoop/auth` → complete OAuth → copy the `WHOOP_REFRESH_TOKEN` shown

#### Strava
1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) → create an app
2. Set redirect URI to `http://localhost:3000/api/strava/callback`
3. Copy Client ID + Secret into `.env.local`
4. Visit `http://localhost:3000/api/strava/auth` → complete OAuth → copy the `STRAVA_REFRESH_TOKEN` shown

#### Anthropic
Get an API key from [console.anthropic.com](https://console.anthropic.com).

#### MyFitnessPal
Just your regular MFP username and password. The app uses the internal mobile API.

#### Telegram bot
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts
2. Copy the token into `TELEGRAM_BOT_TOKEN`
3. Set `TELEGRAM_WEBHOOK_SECRET` to any random string

### 4. Run the dev server

```bash
npm run dev
```

Dashboard is at [http://localhost:3000](http://localhost:3000).

### 5. Set up Telegram webhook (local)

Telegram webhooks need a public HTTPS URL. Use localtunnel (no account needed):

```bash
npx localtunnel --port 3000
# prints: your url is: https://xxxx.loca.lt
```

Register it:

```bash
curl "https://xxxx.loca.lt/api/telegram/setup"
# should return: {"telegram":{"ok":true,...}}
```

Then message your bot on Telegram — it should reply within a few seconds.

> **Note:** localtunnel URLs are temporary. Re-run the two commands above each dev session.

---

## Project structure

```
app/
  page.tsx                  # Main dashboard — fetches all data, manages state
  globals.css               # All styles (glassmorphic design system)
  api/
    brief/                  # Claude daily brief (GET: cached, POST: regenerate)
    whoop/                  # Whoop metrics + OAuth flow
    strava/                 # Strava activity data + OAuth flow
    mfp/                    # MyFitnessPal macros for today
    coach-state/            # Dashboard polls this every 30s for bot-driven meal overrides
    weight-log/             # Save weight entries from Telegram bot
    telegram/
      webhook/              # Telegram bot entry point (POST from Telegram servers)
      setup/                # One-time webhook registration (GET)
    webhooks/
      whoop/                # Whoop recovery.scored event → regenerate brief → Telegram delivery
    cron/
      morning/              # Fallback cron at 6 AM (primary trigger is Whoop webhook)

components/
  TopBar.tsx                # Header: date, clock, race countdown
  MorningBrief.tsx          # Claude brief with chips
  MetricsRow.tsx            # 5 Whoop metric cards
  StravaPanel.tsx           # Activity charts (run/walk/gym bars)
  NutritionPanel.tsx        # Macro targets, meal plan, ADJUSTED badges

lib/
  claude.ts                 # Daily brief generation — rich prompt with 7-day history
  whoop.ts                  # Whoop API client (recovery, sleep, cycle, body measurement)
  strava.ts                 # Strava API client (40-week paginated history)
  mfp.ts                    # MyFitnessPal internal API client
  briefCache.ts             # File-based brief cache (.brief-cache/)
  telegramCoach.ts          # Core coach logic — Claude calls, vital-action parsing
  telegram.ts               # Telegram API helpers
  coachState.ts             # Meal overrides + pending barcode state (.vital-memory/)
  weightLog.ts              # Weight log read/write
  openFoodFacts.ts          # Barcode lookup via Open Food Facts

.vital-memory/              # Persistent state (gitignored)
  user-profile.md           # Long-term coach memory — update body composition goal
  overrides.json            # Today's meal overrides from bot (resets daily)
  weight-log.json           # Running weight log
  telegram-config.json      # Stores your Telegram chat_id (set on first message)

.brief-cache/               # Cached daily briefs (gitignored)
```

---

## How the AI brief works

Every morning (triggered by Whoop's `recovery.scored` webhook when you wake up):

1. Fetches today's Whoop recovery, HRV, sleep score
2. Fetches 7-day Whoop history (trend: improving/declining/stable)
3. Fetches 8 weeks of Strava training load
4. Fetches last 3 days of MFP nutrition
5. Reads `.vital-memory/user-profile.md` (your goals, baselines, coach notes)
6. Sends everything to Claude → returns brief body + 4 meals + insight chips
7. Caches result to `.brief-cache/YYYY-MM-DD.json`
8. Sends short summary to Telegram

Claude also appends one-line insights to `user-profile.md` after each brief — this is the long-term memory that improves coaching over time.

**To force a regeneration:**
```bash
curl -X POST http://localhost:3000/api/brief
```

---

## Telegram bot capabilities

| Message | What happens |
|---|---|
| Any question | Coach answers with full health context |
| *"I had pizza for lunch, 900 cal"* | Updates lunch on dashboard with ADJUSTED badge |
| *"log weight 174"* | Saves to weight log |
| Photo of a meal | Claude Vision identifies food, estimates macros |
| Photo of a barcode | Open Food Facts lookup → asks quantity → calculates macros |

Meal overrides appear on the dashboard within 30 seconds (polling interval).

---

## Deploying to Vercel

```bash
npm i -g vercel
vercel --prod
```

Add all env vars in the Vercel dashboard (Settings → Environment Variables). Update redirect URIs in Whoop and Strava developer consoles to your Vercel domain.

**Post-deploy setup:**

```bash
# Register Telegram webhook
curl "https://your-app.vercel.app/api/telegram/setup"

# Register Whoop webhook
# In Whoop Developer Console → Webhooks → add:
# URL: https://your-app.vercel.app/api/webhooks/whoop
# Event: recovery.scored
# Copy the signing secret → add as WHOOP_WEBHOOK_SECRET in Vercel
```

**Important:** `.vital-memory/` and `.brief-cache/` are filesystem-based and won't persist on Vercel's serverless functions between deployments. For production persistence, these should be migrated to Vercel KV or a similar key-value store.

---

## Kiosk setup (Raspberry Pi)

1. Deploy to Vercel
2. On the Pi, open Chromium in kiosk mode:
   ```bash
   chromium-browser --kiosk --noerrdialogs --disable-infobars https://your-app.vercel.app
   ```
3. Disable screen sleep:
   ```bash
   xset s off && xset -dpms && xset s noblank
   ```

---

## Tech stack

- **Next.js 16** (App Router, TypeScript)
- **Anthropic claude-sonnet-4-6** — daily brief + Telegram coach + Vision
- **Whoop API v1/v2** — recovery, sleep, cycle, body measurement
- **Strava API** — 40-week activity history
- **MyFitnessPal** — internal mobile API (reverse-engineered)
- **Open Food Facts** — free barcode/product database
- **Telegram Bot API** — webhook-based bot
- Custom glassmorphic CSS design system (no UI library)
