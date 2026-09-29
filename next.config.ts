import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the dev server to serve dev resources (/_next/hmr and the
  // hydration bootstrap) to this host-only adapter IP. Without this entry,
  // Next.js 16 blocks cross-origin dev resources for that origin: the page
  // server-renders fine but never hydrates, so every button renders yet does
  // nothing. Does not affect production builds.
  allowedDevOrigins: ["192.168.56.1"],
};

export default nextConfig;
