import type { CapacitorConfig } from '@capacitor/cli';

// This app is a full server-rendered Next.js app (API routes, middleware,
// Supabase auth cookies) — not something that can be exported to a static
// bundle and shipped inside the APK. So the native shell doesn't carry a
// copy of the site; it points its WebView at the real, live production
// server instead (`server.url` below). That's also the whole reason
// future feature updates don't need a new APK: the shell just loads
// whatever's live at dhabpari.com the next time it opens. `webDir` still
// has to point at *something* on disk for `cap` to accept the config —
// it's never actually used since `server.url` takes over at runtime.
const config: CapacitorConfig = {
  appId: 'com.dhabpari.app',
  appName: 'Dhab Pari',
  webDir: 'public-shell',
  server: {
    url: 'https://dhabpari.com',
    androidScheme: 'https',
    // Lets Android's WebView follow normal https navigation/redirects on
    // the real domain — no cleartext (plain http) traffic is allowed.
    allowNavigation: ['dhabpari.com', '*.dhabpari.com'],
  },
};

export default config;
