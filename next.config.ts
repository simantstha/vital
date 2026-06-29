import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for the Docker image.
  output: "standalone",
  // Pin the file-tracing root to this project so the standalone output lands at
  // .next/standalone/server.js (a parent lockfile would otherwise nest it under
  // .next/standalone/vital/ and break the Dockerfile copy paths).
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
