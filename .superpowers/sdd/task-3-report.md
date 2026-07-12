# Task 3 Report — iOS transport, state, and restoration

## Status

Implemented the specialist transport contracts and authoritative coach state without changing Task 4 presentation styling.

## Delivered

- Added `GET /api/coach` decoding for the latest transcript, authoritative persona, pending specialist card, restored speaker/session metadata, and arbitrary structured return summaries.
- Preserved legacy `text`, `tool_call`, and `tool_data` SSE handling while adding `handoff_card`, `persona_changed`, `done`, and streamed server-error decoding.
- Added POST action transport for `accept_handoff`, `decline_handoff`, `accept_return`, and `decline_return` with deterministic `ios:<session>:<action>` idempotency keys.
- Added an injectable `CoachAPIProviding` seam and synchronous in-flight action gating so duplicate taps cannot race onto the wire.
- Added explicit `CoachSpecialistState` cases for Vital, pending proposal, active consultation, pending return, and recoverable rollback.
- Restored transcript/persona/card state before falling back to the legacy opener. Persona changes only occur from REST state or explicit SSE events, never from prose.
- Added an explicit joined system message when the authoritative persona changes from Vital to Running Coach.
- Snapshotted the speaker identity on streamed assistant turns and copied immutable specialist metadata onto restored messages so historical labels remain `Running Coach` after returning to Vital.
- Retained Running Coach after an interrupted stream when no authoritative rollback event arrived; a server `persona_changed` event to Vital followed by an error produces recoverable rollback state.

## TDD evidence

### RED

The specialist tests were added before production implementation and the generated Xcode project was refreshed with `xcodegen generate`.

Command:

```sh
xcodebuild test -quiet -project Vital.xcodeproj -scheme Vital \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:VitalTests/CoachSpecialistStateTests CODE_SIGNING_ALLOWED=NO
```

Observed: exit `65`, with expected missing-feature compilation failures including:

- `cannot find 'CoachPersonaSnapshot' in scope`
- `cannot find type 'CoachAPIProviding' in scope`
- `cannot find type 'SpecialistAction' in scope`
- `cannot find type 'CoachRestorationResponse' in scope`

This established that the tests failed because the requested contracts/state did not yet exist.

### GREEN — focused

After implementation, a fresh derived-data build completed with exit `0`:

```sh
xcodebuild build-for-testing -quiet -project Vital.xcodeproj -scheme Vital \
  -destination 'id=D04B59E8-5D17-44D6-8E2C-705BEC126CBD' \
  -derivedDataPath /tmp/VitalTask3Derived CODE_SIGNING_ALLOWED=NO
```

Focused execution used a freshly booted simulator after Xcode's first simulator worker stalled during launch:

```sh
xcodebuild test-without-building -project Vital.xcodeproj -scheme Vital \
  -destination 'id=6A6ABF95-A3DC-4196-BC9E-97CCBE4797D8' \
  -derivedDataPath /tmp/VitalTask3Derived \
  -only-testing:VitalTests/CoachSpecialistStateTests CODE_SIGNING_ALLOWED=NO
```

Observed: exit `0`, `9 tests`, `0 failures`, `** TEST EXECUTE SUCCEEDED **`.

Covered:

- new REST restoration decoding
- new and legacy SSE decoding
- all four stable action request payloads
- pending-return and active-persona restoration
- duplicate in-flight tap suppression
- authoritative acceptance and joined-system message
- interruption retention
- server-directed failure rollback to Vital
- persistent historical specialist labels

### GREEN — full iOS suite

```sh
xcodebuild test-without-building -project Vital.xcodeproj -scheme Vital \
  -destination 'id=6A6ABF95-A3DC-4196-BC9E-97CCBE4797D8' \
  -derivedDataPath /tmp/VitalTask3Derived CODE_SIGNING_ALLOWED=NO
```

Observed: exit `0`, `22 tests`, `0 failures`, `** TEST EXECUTE SUCCEEDED **`.

### GREEN — app build

```sh
xcodebuild build -quiet -project Vital.xcodeproj -scheme Vital \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/VitalTask3Build CODE_SIGNING_ALLOWED=NO
```

Observed: exit `0`.

## Files changed

- `ios/Vital/Sources/Core/APIClient.swift`
- `ios/Vital/Sources/Features/Coach/CoachViewModel.swift`
- `ios/Vital/Tests/CoachSpecialistStateTests.swift`
- `.superpowers/sdd/task-3-report.md`

The regenerated `ios/Vital/Vital.xcodeproj` remains ignored and is not part of the commit.

## Concerns / follow-up

- Xcode initially stalled with `waiting for workers to materialize` on the existing booted simulator. A fresh derived-data directory plus a different freshly booted simulator produced clean exit-0 focused and full test executions.
- The build continues to emit pre-existing actor-isolation warnings in `HealthSyncCoordinator.swift:201`; Task 3 did not modify that file.
- Card/header/avatar/glow presentation and specialist action controls remain intentionally assigned to Task 4.
