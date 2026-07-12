#!/bin/sh
set -e

# Seed the persistent volume with the baked-in .vital-memory defaults on first
# boot. On subsequent boots the volume already holds the user's live state, so
# we leave it untouched.
if [ ! -d /data/.vital-memory ]; then
  echo "[entrypoint] Seeding /data/.vital-memory from image defaults..."
  mkdir -p /data
  cp -r /seed/.vital-memory /data/.vital-memory
fi

# Ensure the daily-brief cache directory exists on the volume.
mkdir -p /data/.brief-cache

exec "$@"
