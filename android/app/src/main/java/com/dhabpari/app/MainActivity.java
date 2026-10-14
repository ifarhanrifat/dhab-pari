package com.dhabpari.app;

import android.os.Bundle;
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
