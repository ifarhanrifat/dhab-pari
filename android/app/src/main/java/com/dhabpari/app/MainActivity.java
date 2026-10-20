package com.dhabpari.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Explicit registration — see AppSettingsPlugin's own header comment
        // for why this replaced capacitor-native-settings's auto-discovery.
        registerPlugin(AppSettingsPlugin.class);
        registerPlugin(WhatsAppSharePlugin.class);
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);

        // Real bug, confirmed live, 2026-10-20: a page (the committee
        // announcement card) went stale inside this app specifically —
        // the same URL in a plain Chrome tab on the same device always
        // showed the current content. The server side was already
        // confirmed correct (the document and sw.js are both served
        // fully uncacheable — Cache-Control: no-store / must-revalidate
        // — and the service worker itself does no caching of its own at
        // all), and a web-only fix (updateViaCache: 'none' on the
        // service worker registration) didn't hold either — because that
        // fix lives inside the very JS bundle that was itself stale, so
        // a device already stuck could never run it to begin with. Only
        // a full reinstall — which wipes this WebView's own storage —
        // ever actually cleared it, which is the real tell: Android's
        // WebView component keeps its OWN native HTTP disk cache,
        // underneath both the Service Worker and this app's own JS, and
        // its default cache mode (LOAD_DEFAULT) does not reliably treat
        // this app's top-level page the way a full Chrome browser does.
        // Forcing LOAD_NO_CACHE here means every request this WebView
        // makes always goes to the network, full stop — a native-level
        // guarantee that doesn't depend on any JS (service worker or
        // otherwise) ever running correctly to take effect, so it can't
        // be defeated by the exact failure mode that caused this bug.
        WebView earlyWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (earlyWebView != null) {
            earlyWebView.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        }

        // Real bug, confirmed live on a Pixel 4a: the ticker/header rendered
        // behind the status bar. targetSdkVersion 36 (variables.gradle)
        // means Android enforces edge-to-edge with NO opt-out at this API
        // level — the WebView draws under the status bar whether this app
        // asks for it or not.
        //
        // First attempt was just setDecorFitsSystemWindows(false), on the
        // theory that it's what makes Chromium populate the CSS
        // env(safe-area-inset-*) values the web app already uses. Rebuilt,
        // installed over the existing app, confirmed on-device: no change
        // at all — Capacitor 8's BridgeActivity (checked its actual source
        // in node_modules) has no built-in edge-to-edge/insets handling
        // whatsoever, so there was nothing on this end dispatching real
        // inset values into the WebView for Chromium to read in the first
        // place; the Window-level flag alone doesn't produce that.
        //
        // This instead reads the real system-bar inset values directly via
        // WindowInsetsCompat and applies them as native padding on the
        // WebView itself. That fixes the overlap unconditionally, at the
        // native layer, independent of whether env(safe-area-inset-*)
        // ever populates correctly in this WebView version — the web CSS
        // fix (padding-top: env(safe-area-inset-top, 0px)) stays harmless
        // dead weight if this value is 0 there, additive and correct if a
        // future WebView update makes it work too.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            }
            return insets;
        });
    }
}
