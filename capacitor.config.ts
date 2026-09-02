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
    // Must be the exact origin the WebView actually renders, byte-for-byte
    // — Capacitor's bridge-JS injection (addDocumentStartJavaScript) is
    // locked to Collections.singleton(this origin) with no fallback path.
    // dhabpari.com (apex) 308-redirects to www.dhabpari.com, so the old
    // 'https://dhabpari.com' here meant the injected script — the thing
    // that sets window.Capacitor.PluginHeaders — never ran on the page
    // that actually loaded. Capacitor.isNativePlatform() still correctly
    // returned true throughout (that check uses a separate, broader
    // androidBridge origin allowlist derived from allowNavigation below,
    // which does cover www) — which is exactly what made this so
    // confusing: the app "knew" it was native, every plugin call still
    // threw "plugin is not implemented on android" regardless of which
    // plugin or how it was registered. Any future redirect away from this
    // exact URL (locale prefix, auth bounce, domain change) reintroduces
    // the same failure — keep this byte-identical to the real landing origin.
    url: 'https://www.dhabpari.com',
    androidScheme: 'https',
    // Lets Android's WebView follow normal https navigation/redirects on
    // the real domain — no cleartext (plain http) traffic is allowed.
    allowNavigation: ['dhabpari.com', '*.dhabpari.com'],
  },
};

export default config;
