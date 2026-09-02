package com.dhabpari.app;

// A minimal, in-app replacement for the third-party capacitor-native-settings
// plugin — that one's registration looked entirely correct on paper (present
// in capacitor.plugins.json, its class compiled into the release dex,
// correctly signed) and still surfaced "plugin is not implemented on
// android" at runtime, meaning something about its auto-discovery wiring
// wasn't taking effect for reasons static inspection alone couldn't pin
// down. Registering a plugin explicitly here, in the same module as
// MainActivity, sidesteps that auto-discovery path entirely — this is
// Capacitor's most basic mechanism (registerPlugin() in onCreate()) and
// has no dependency on any third-party package's own build/packaging.
//
// Only exposes the two settings screens this app actually needs (the
// Location toggle, and the app's own permission details screen), not a
// general-purpose "open any settings screen" API.

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        openScreen(call, Settings.ACTION_LOCATION_SOURCE_SETTINGS, false);
    }

    @PluginMethod
    public void openAppDetailsSettings(PluginCall call) {
        openScreen(call, Settings.ACTION_APPLICATION_DETAILS_SETTINGS, true);
    }

    private void openScreen(PluginCall call, String action, boolean withPackageUri) {
        try {
            Intent intent = new Intent(action);
            if (withPackageUri) {
                intent.setData(Uri.parse("package:" + getActivity().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("status", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not open settings: " + e.getMessage(), e);
        }
    }
}
