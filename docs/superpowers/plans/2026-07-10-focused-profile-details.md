# Focused Profile Details Implementation Plan

> **For agentic workers:** Follow test-driven development and stay within the assigned file ownership.

**Goal:** Show the user's saved personal details on Profile while keeping the screen focused on Profile details, Daily Budget, Activity, and Sign Out.

**Architecture:** Extend `GET /api/profile` with read-only Identity details parsed from the existing per-user `core-profile.md`. Decode and format those details in the iOS view model, then reshape the existing SwiftUI screen using only Vital's current design-system components.

**Tech Stack:** Next.js route handlers, TypeScript, Swift, SwiftUI, XCTest/XcodeGen.

## Global Constraints

- Preserve the current centered avatar, glass surfaces, typography, spacing, colors, and floating five-tab navigation.
- Profile details are read-only: age, height, current weight, and biological sex.
- Activity retains logged days, meals logged, average HRV, and workouts.
- Apple Health status and health-history resync move into the top-right menu.
- Sign Out remains visible at the bottom with confirmation.
- Missing profile or HRV values display `--`; they must not fail the response or screen.
- Do not add database migrations, dependencies, profile editing, or unrelated refactors.

## Tasks

1. Add a focused parser for Identity fields in `core-profile.md`, unit-test valid and malformed inputs, and expose the nullable `profile` object from `/api/profile`.
2. Add the matching iOS DTO, make `avgHrv` nullable, and unit-test stable profile/activity cell formatting for metric and US measurement systems.
3. Recompose `ProfileView` around Profile details, Daily Budget, Activity, the overflow health menu, and visible Sign Out using existing Vital components.
4. Review the integrated diff, run TypeScript/lint/iOS tests and builds, perform simulator visual checks, then push and open a PR.
