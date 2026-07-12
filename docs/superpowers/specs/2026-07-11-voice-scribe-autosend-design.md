# Voice Upgrade: ElevenLabs Scribe STT + Auto-Send on Pause

## Context

The coach's spoken replies already use ElevenLabs TTS (`/api/tts`), but **speech input** still uses Apple's `SFSpeechRecognizer` with on-device recognition forced (`SpeechTranscriber.swift:94-96`), which misses/mangles words. Also, voice turns require a manual tap to stop and send.

User-approved decisions:
1. **Hybrid STT**: keep Apple's live partial text as an on-screen preview while speaking; on stop, upload the recorded audio to a new `POST /api/stt` route (ElevenLabs Scribe `scribe_v1`) — the accurate cloud transcript replaces the preview and is what gets sent. Any failure falls back to the Apple transcript (no regression).
2. **Auto-send on pause**: one turn only — silence (~1.8s with non-empty text) auto-stops and sends. Guards: 10s no-speech timeout (nothing sent), 30s max-duration cap. No continuous conversation loop (future layer).
3. **Both surfaces**: coach chat AND meal-logging voice search. `LogMealViewModel` currently duplicates the STT engine inline (lines 74-244) — refactor it onto the shared `SpeechTranscriber`.

Pause detection = restartable timer reset on each SFSpeech partial (partials only arrive while speech is decoded → robust end-of-utterance signal, no RMS/noise-floor tuning).

## Changes

### 1. Backend — `app/api/stt/route.ts` (new)
Mirror `app/api/tts/route.ts` structure: `getUserIdFromRequest` → 401, `force-dynamic`, `ELEVENLABS_API_KEY` (already set for TTS) → 503 if unset, upstream failure → 502.
- Request: **raw audio body** (`Content-Type: audio/mp4`), read via `request.arrayBuffer()`; empty → 400, >10 MB → 413.
- Upstream: server-side `FormData` — `file` (Blob, `audio.m4a`), `model_id: scribe_v1`, `language_code: en`, `tag_audio_events: false` → `POST https://api.elevenlabs.io/v1/speech-to-text` with `xi-api-key` header (don't set Content-Type manually; fetch sets the multipart boundary).
- Response: `{ text }`.

### 2. iOS — extend `ios/Vital/Sources/Core/SpeechTranscriber.swift`
- Write tap buffers to a temp `.m4a` alongside recognition: `AVAudioFile(forWriting:)` with `kAudioFormatMPEG4AAC`, sample rate + **channel count matching the input format** (mono settings on a stereo tap throws). Capture the file locally in the tap closure (like `[weak req]`) — audio thread must not touch @MainActor state. File-creation failure → proceed Apple-only.
- New: `private(set) var recordingURL: URL?`, `discardRecording()`, constants `silenceThreshold = 1.8`, `noSpeechTimeout = 10`, `maxDuration = 30`.
- Three cancellation-safe @MainActor watchdog Tasks: silence timer (restarted on each non-empty partial), no-speech timeout, max-duration cap — each calls `stop()`.
- `stop()` ordering: cancel watchdogs, release the AVAudioFile handle and set `recordingURL` **before** flipping `isRecording = false` (Combine subscribers read `recordingURL` on the flip). Do NOT reorder the AVAudioSession setup in `start()` (first-grant AudioToolbox crash fix depends on it).

### 3. iOS — `APIClient.swift`: `uploadSTTAudio(fileURL:) async -> String?`
Next to `fetchTTSAudio` (line 233), same swallow-errors contract: POST raw body to `/api/stt` via `authorizedRequest`, `Content-Type: audio/mp4`, 30s timeout; return trimmed non-empty text on 200 else nil.

### 4. iOS — `CoachViewModel.swift` flow
- Add `@Published var isTranscribing` + `transcriptionTask`.
- `toggleVoiceRecording()` (line 258): also guard `!isTranscribing`; manual tap-to-stop kept.
- Rewrite `finishVoiceInput()` (270-276): capture Apple transcript + `recordingURL` → `isTranscribing = true` → Task: try `uploadSTTAudio`; cloud text (if non-empty) else Apple text; empty both → clear input, send nothing; else `input = text; pendingSentByVoice = true; send()`. `defer { isTranscribing = false; transcriber.discardRecording() }`.
- `cancelStreaming()` (line 389): also cancel `transcriptionTask`.

### 5. iOS — `CoachView.swift` UI
Mic button 3 states: idle → recording (unchanged pulse) → **transcribing** (ProgressView in circle, disabled). Extend existing `vm.transcriber.isRecording` disables (lines 149/182/222) with `|| vm.isTranscribing`. Preview text stays in `input` so the cloud replacement is visible.

### 6. iOS — refactor `LogMealViewModel.swift` (+ `LogMealView.swift`)
- Delete inline engine (props 66-69, 74-77; Voice section 144-244). Add `let transcriber = SpeechTranscriber()`, `isTranscribing`, `isVoiceInputActive`; forward `objectWillChange`; bind `$isRecording` false-flip → `finishVoiceInput()`.
- Thin wrappers keep view changes small: `checkSpeechPermissions()`, `requestSpeechPermissions()`, `toggleRecording()`, `fullReset()`.
- `finishVoiceInput()` ends with `searchText = text; await searchByText()` — preserves existing auto-search-on-final (old lines 201-208), now on any stop.
- `LogMealView.swift` (~278-331): permission checks → `transcriber.permissionState`; `vm.isRecording`/`vm.transcribedText` → transcriber's; add "Transcribing…" row.

## Error/fallback matrix
| Failure | Behavior |
|---|---|
| /api/stt unreachable / non-200 / 503 / empty | Apple transcript sent (current behavior) |
| AVAudioFile create/write fails | Apple-only, `recordingURL` nil |
| Apple empty but audio captured | Cloud STT still attempted |
| Both empty (no-speech timeout) | Nothing sent, back to idle |
| Permission denied / recognizer unavailable | Unchanged existing paths |

## Execution constraints (project rules)
- Orchestrator (this model) must NOT edit code — delegate all edits to a **Sonnet subagent** (multi-file backend + iOS + UI). Review diff, build, test, then commit.
- Feature branch `feat/voice-scribe-autosend`, PR to main, never merge.

## Verification
Backend: `say -o /tmp/stt-test.m4a --data-format=aac "I had two eggs and toast for breakfast"`, then curl `POST /api/stt` with dev-auth Bearer token → expect that text; also verify 401 (no token) and 503 (key unset).
iOS: xcodegen + simulator build + existing tests. Simulator: SFSpeech partials unreliable → expect no-speech-timeout path, which still exercises upload + cloud transcript. Full hybrid flow (live preview → 2s pause → auto-stop → spinner → replaced transcript → spoken reply; meal-log voice → auto search) needs a **physical device**; device hits Fly backend, so `/api/stt` must be deployed (or point `apiBaseURL` at LAN IP). Airplane-mode mid-flow → Apple transcript still sends.
