package com.dhabpari.app;

// The web share flow (receiptExport.ts's shareReceipt()) can only put an
// image on the clipboard and open a wa.me link -- no browser API can attach
// a file into another site's composer, so a PDF (which can't even be
// clipboard-pasted) always had to be "downloaded, please attach manually."
// Running inside a real Android app instead of a browser tab removes that
// ceiling: an explicit-package ACTION_SEND intent hands WhatsApp the actual
// file, already attached, and opens straight to its own contact picker --
// the same "Share to WhatsApp" pattern most apps with a share button use.
// setPackage("com.whatsapp") means this never shows a generic chooser (the
// same shared-committee-phone leak concern that removed navigator.share()
// from the web flow doesn't apply here, since the target is pinned).
//
// Registered explicitly in MainActivity -- see AppSettingsPlugin's header
// comment for why this project doesn't rely on Capacitor's plugin
// auto-discovery.

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "WhatsAppShare")
public class WhatsAppSharePlugin extends Plugin {

    // A real committee phone is just as likely to carry WhatsApp Business
    // (com.whatsapp.w4b) as regular WhatsApp, or both -- the first version
    // of this plugin only ever checked/targeted "com.whatsapp", so on a
    // Business-only device isAvailable() always came back false and every
    // share silently fell back to the old download+wa.me flow with no
    // visible error at all (shareReceipt()'s native attempt is wrapped in
    // .catch(() => false), by design, so it degrades quietly -- which is
    // exactly why this looked like "nothing changed" instead of an error).
    private static final String[] WHATSAPP_PACKAGES = { "com.whatsapp", "com.whatsapp.w4b" };

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", findInstalledWhatsAppPackage() != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType");
        String filename = call.getString("filename");

        if (base64Data == null || mimeType == null || filename == null) {
            call.reject("base64Data, mimeType and filename are all required");
            return;
        }
        String targetPackage = findInstalledWhatsAppPackage();
        if (targetPackage == null) {
            call.reject("WhatsApp is not installed");
            return;
        }

        try {
            // A fresh subdirectory of the cache, matching file_paths.xml's
            // cache-path root -- cleared per share, never accumulates.
            File shareDir = new File(getContext().getCacheDir(), "shares");
            if (!shareDir.exists()) shareDir.mkdirs();
            File outFile = new File(shareDir, filename);

            byte[] bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
            }

            Uri uri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", outFile
            );

            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.setPackage(targetPackage);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("WhatsApp did not accept the share intent");
                return;
            }

            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("status", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not share to WhatsApp: " + e.getMessage(), e);
        }
    }

    /** Regular WhatsApp preferred over Business when both are installed; null if neither is. */
    private String findInstalledWhatsAppPackage() {
        PackageManager pm = getContext().getPackageManager();
        for (String pkg : WHATSAPP_PACKAGES) {
            try {
                pm.getPackageInfo(pkg, 0);
                return pkg;
            } catch (PackageManager.NameNotFoundException ignored) {
                // try the next candidate
            }
        }
        return null;
    }
}
