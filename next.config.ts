import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
