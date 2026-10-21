import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: lets the HMR websocket connect when the dev server is reached
  // via 127.0.0.1 (e.g. `adb reverse` tunneling a connected phone's Chrome
  // to this machine's dev server) instead of "localhost" — otherwise
  // Turbopack's dev client keeps retrying/reloading forever, which looked
  // like a real hydration failure (infinite loading spinner) until this
  // was traced to the blocked-origin warning in the server's own log.
  allowedDevOrigins: ['127.0.0.1'],
  // /accounts was renamed to /marketplace, 2026-09-27 — the marketplace
  // rewrite (phase 5) had already repurposed the route's content, but the
  // URL itself still said "accounts" everywhere (nav, homepage links, the
  // committee-note feature-link picker). Old bookmarks/shared links still
  // need to land somewhere real.
  async redirects() {
    return [
      { source: '/accounts', destination: '/marketplace', permanent: true },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
    ],
  },
};

export default nextConfig;
