# Vital — Fly.io Deployment Runbook

Deploys the Next.js backend to Fly.io with a Supabase Postgres and shared-secret
API auth, so the iOS app can talk to a hosted server instead of `localhost:3000`.

## Architecture on Fly

- **App**: Next.js standalone server in a Docker container (`Dockerfile`).
- **DB**: Supabase Postgres (external). Connection string set as a Fly secret.
- **Persistence**: a Fly volume `vital_data` mounted at `/data`. The file-based
  state (`.vital-memory/`, `.brief-cache/`) lives there via `VITAL_DATA_DIR=/data`.
  The volume is seeded from the image's baked-in `.vital-memory` on first boot
  (`scripts/docker-entrypoint.sh`).
- **Auth**: `middleware.ts` requires `Authorization: Bearer <API_SHARED_SECRET>`
  on every `/api/*` request except `/api/health`. The iOS client injects it
  globally (`APIClient.swift`).

## One-time prerequisites (interactive — you run these)

### 1. Log into Fly
```
fly auth login
```

### 2. Create a Supabase project + get the connection string
- Create a project at https://supabase.com/dashboard (free tier).
- Project Settings → Database → **Connection string** → **Session mode**
  (this supports prepared statements, which postgres.js uses — do NOT use the
  transaction pooler on 6543 without code changes).
- It looks like:
  `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`

Hand that string back, and the rest can be automated.

## Deploy steps

### 3. Run schema migrations against Supabase (from this machine)
```
DATABASE_URL="<supabase-session-string>" npx drizzle-kit migrate
```

### 4. Create the Fly app + volume
```
fly apps create vital-coach          # pick a unique name; update fly.toml if taken
fly volumes create vital_data --region ord --size 1 --yes
```

### 5. Set secrets
```
fly secrets set \
  DATABASE_URL="<supabase-session-string>" \
  API_SHARED_SECRET="<the 64-char hex token, matches APIClient.swift>" \
  ANTHROPIC_API_KEY="..." \
  WHOOP_CLIENT_ID="..." WHOOP_CLIENT_SECRET="..." WHOOP_REFRESH_TOKEN="..." WHOOP_REDIRECT_URI="..." WHOOP_WEBHOOK_SECRET="..." \
  STRAVA_CLIENT_ID="..." STRAVA_CLIENT_SECRET="..." STRAVA_REFRESH_TOKEN="..." STRAVA_REDIRECT_URI="..." \
  MFP_USERNAME="..." MFP_PASSWORD="..." \
  CALORIENINJAS_API_KEY="..." \
  ELEVENLABS_API_KEY="..." \
  V0_API_KEY="..."
```
(Values come from `.env.local`. `VITAL_DATA_DIR` and `PORT` are already in `fly.toml [env]`.)

### 6. Deploy
```
fly deploy
```

### 7. Verify
```
curl https://vital-coach.fly.dev/api/health                # {"ok":true}
curl -i https://vital-coach.fly.dev/api/today              # 401 Unauthorized (auth works)
curl -s https://vital-coach.fly.dev/api/today \
  -H "Authorization: Bearer <API_SHARED_SECRET>"           # real JSON
```

## iOS install

`APIClient.swift` already points at `https://vital-coach.fly.dev` and sends the
bearer token. To run on a physical device:
- Open `ios/Vital` in Xcode, select your iPhone as the run target.
- Signing & Capabilities → set your Team (a free Apple ID works for 7-day
  personal provisioning; a paid Apple Developer account for longer).
- Build & Run. The app will hit the Fly backend.

## Notes / follow-ups

- The **web dashboard** (`/`) fetches `/api/*` from the browser without the
  token, so it will show error states against the deployed backend. Expected —
  the iOS app is the client. (To use the web UI, it would need the token too.)
- If the app name `vital-coach` is taken, change it in `fly.toml` AND in
  `APIClient.swift` (`apiBaseURL`).
- Schema changes: re-run step 3 against Supabase, then `fly deploy`.
