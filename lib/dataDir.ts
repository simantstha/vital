import path from 'path';

/**
 * Root directory for Vital's file-based runtime state (.vital-memory, .brief-cache).
 *
 * Local development: defaults to the project root (process.cwd()), so the
 * committed seed files under .vital-memory are read/written in place.
 *
 * Production (Fly.io): set VITAL_DATA_DIR=/data to point at a mounted persistent
 * volume. The container filesystem is otherwise ephemeral and these writes
 * (user profile, weight log, coach overrides, pending meals) would be lost on
 * every deploy/restart.
 */
export const DATA_DIR = process.env.VITAL_DATA_DIR
  ? path.resolve(process.env.VITAL_DATA_DIR)
  : process.cwd();
