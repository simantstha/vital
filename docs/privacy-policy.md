# Vital Privacy Policy

> **DRAFT for owner review — not legal advice, not yet published.** Written from what
> the code actually stores and sends (`db/schema.ts`, `app/api/*`). The owner must
> confirm contact details, retention, jurisdiction-specific clauses (GDPR/CCPA), and
> host this at the URL used by `AppLinks.privacyPolicy` in the iOS app
> (currently the placeholder `https://vital.app/privacy`). Items in [brackets] need a decision.

**Effective date:** [DATE]
**Contact:** [privacy contact email]

Vital is a personal health and fitness coach. This policy explains what we collect,
why, who helps us process it, and how you can delete it.

## What we collect

**Account.** When you use Sign in with Apple we receive an Apple identifier and, if
you share them, your name and email (or an Apple private-relay address). We use these
to create and recognise your account.

**Profile and goals.** Information you give us: name, age, height, weight, target
weight and date, goal, calorie/macro targets, sleep goal, time zone, unit preference,
and notification preferences.

**Health data from Apple Health (HealthKit).** With your permission, we read metrics
such as heart rate, heart-rate variability, resting heart rate, sleep, steps, active
energy, body measurements, and workouts (type, duration, heart rate, zones, energy),
and send them to our servers to compute trends, baselines, recovery, and coaching.
We do not use HealthKit data for
advertising or sell it.

**WHOOP data (optional).** If you connect WHOOP, we store your WHOOP user ID and
OAuth access/refresh tokens, and sync your cycles, recovery, sleep, and workouts.

**Meals and food.** Meals you log by text, voice, photo, or barcode, with calories and
macros. Photos you send to the coach may be stored with your chat messages.

**Chat, voice, and memory.** Your messages with the coach and its replies; facts the
coach remembers about you (for example injuries, preferences, training history, lab
results you share) and which you can review in the Memory screen. If you use voice,
your audio is sent for transcription and the coach's reply may be sent for speech
synthesis (see providers below). We do not keep the audio recordings.

**Calendar (optional).** If you enable it, busy/free time blocks from your calendar
are used to schedule training and reminders.

**Notifications.** Your Apple push device token and delivery records so we can send
reminders, morning briefs, and insights.

**Technical.** Basic server logs (such as request errors) needed to run the service.

## How we use it

To provide coaching, briefs, insights, trends, and reminders; to keep your data in
sync across sessions; to secure and operate the service; and to fix bugs. We do not
sell your data or use it to show ads or for cross-app tracking.

## Who processes your data

We use these service providers to run Vital. They process data only to provide their
service to us:

| Provider | Purpose | Data involved |
| --- | --- | --- |
| **Anthropic** (Claude) | AI coaching, meal/workout/sleep analysis, briefs | Chat content, meal text/photos, and relevant health summaries sent as context |
| **ElevenLabs** | Voice transcription (speech-to-text) and coach voice (text-to-speech) | Voice audio you record; text of coach replies you choose to hear |
| **Supabase** (Postgres) | Database | All account and health data listed above |
| **Fly.io** | Application hosting | Data in transit and server-side files |
| **Apple** | Sign in with Apple; push notifications (APNs) | Apple identifier; push token and notification text |
| **WHOOP** | Optional data source | Tokens and data you authorise |
| **USDA FoodData Central, Open Food Facts, Nutritionix** | Nutrition lookups | Food search terms or barcodes (not linked to your identity) |

[Owner: confirm the full current vendor list, including whether Nutritionix is
active, and any analytics/crash-reporting added later.]

## Retention and deletion

We keep your data while your account exists. **You can delete your account at any
time in the app: Profile → Account → Delete account.** This permanently deletes your
profile and all associated data from our database (health metrics, workouts, meals,
messages, memory, goals, notification records, device tokens, and WHOOP
connection/tokens) and cannot be undone. Data previously sent to processors is
governed by their retention terms [owner: confirm, e.g. Anthropic and ElevenLabs
zero-/limited-retention settings]. Backups may persist for up to [N] days before
being overwritten.

To also remove Vital's link to your Apple ID, go to Settings → Apple ID → Sign in
with Apple → Vital → Stop Using Apple ID. To disconnect WHOOP, use Profile → Devices,
or revoke Vital in your WHOOP account settings.

## Your choices and rights

You can revoke Apple Health access in iOS Settings → Health, disable notifications in
iOS Settings, disconnect WHOOP, review and edit what the coach remembers in the
Memory screen, and delete your account. Depending on where you live you may have
rights to access, correct, export, or delete your data, or to object to processing;
contact us at the address above and we will respond within [30] days.

## Security

Data is encrypted in transit (HTTPS) and stored with our database provider.
Session credentials are held in the iOS Keychain. No system is perfectly secure, and
we cannot guarantee absolute security.

## Medical disclaimer

Vital offers general wellness guidance and is not a medical device or a substitute for
professional medical advice.

## Children

Vital is not directed to children under [13/16] and we do not knowingly collect their
data.

## Changes

We will update this policy as the product changes and revise the effective date; we
will notify you in the app for material changes.
