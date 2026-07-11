# Vital Project Memory

## 2026-07-10: Focused Profile details

- `GET /api/profile` now returns a nullable `profile` object with `age`, `biologicalSex`, `heightCm`, and `weightKg`, parsed from the Identity section of `core-profile.md`.
- The iOS Profile tab separates read-only personal details from existing activity totals, keeps Daily Budget and Sign Out visible, and moves Apple Health status and health-history resync into the overflow menu.
