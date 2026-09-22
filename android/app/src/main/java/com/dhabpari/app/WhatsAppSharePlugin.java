package com.dhabpari.app;

// The web share flow (receiptExport.ts's shareReceipt()) can only put an
// image on the clipboard and open a wa.me link -- no browser API can attach
// a file into another site's composer, so a PDF (which can't even be
// clipboard-pasted) always had to be "downloaded, please attach manually."
// Running inside a real Android app instead of a browser tab removes that
// ceiling: an explicit-package ACTION_SEND intent hands WhatsApp the actual
// file, already attached. setPackage("com.whatsapp") means this never
// shows a generic chooser (the same shared-committee-phone leak concern
// that removed navigator.share() from the web flow doesn't apply here,
// since the target is pinned).
//
// Landing directly in one contact's chat (not WhatsApp's own picker) uses
// an undocumented "jid" extra -- real device-confirmed on 2026-09-22 via a
// direct adb test: it is IGNORED (picker shown, same as no jid at all)
// unless that phone number already exists in this phone's own Contacts
// app, in which case it works. So this ensures the contact exists first
// (READ_CONTACTS to check, WRITE_CONTACTS to add it if missing -- rizwan
// explicitly approved this real Contacts-app side effect before it was
// built) and only then attempts jid; if contacts permission is denied, or
// the number can't be resolved, this still falls back to the plain
// attach-then-WhatsApp's-own-picker flow that already worked.
//
// Registered explicitly in MainActivity -- see AppSettingsPlugin's header
// comment for why this project doesn't rely on Capacitor's plugin
// auto-discovery.

import android.Manifest;
import android.content.ContentProviderOperation;
import android.content.Intent;
import android.content.OperationApplicationException;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.RemoteException;
import android.provider.ContactsContract;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;

@CapacitorPlugin(
    name = "WhatsAppShare",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS }, alias = "contacts")
    }
)
public class WhatsAppSharePlugin extends Plugin {

    // Logged at every decision point in the contact-save/jid path (not just
    // caught-and-swallowed) after a real report of "permission granted,
    // still not landing on the contact" with no way to tell which step
    // actually failed -- filter logcat on this tag instead of guessing.
    private static final String TAG = "WhatsAppShare";

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
        String phone = call.getString("phone");
        // Only the contact-lookup/creation step needs the permission; a
        // share with no phone (or one already covered) never prompts for it.
        boolean needsContacts = phone != null && !phone.isEmpty();
        if (needsContacts && getPermissionState("contacts") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPermsCallback");
            return;
        }
        doShareFile(call);
    }

    @PermissionCallback
    private void contactsPermsCallback(PluginCall call) {
        // Denied is a real, expected outcome (this asks for real Contacts
        // access) -- doShareFile()'s own ensureContactSaved() already
        // treats "can't confirm/save the contact" as "skip jid, use the
        // plain attach flow", so a denial here degrades the same way, not
        // as a hard failure.
        doShareFile(call);
    }

    private void doShareFile(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String mimeType = call.getString("mimeType");
        String filename = call.getString("filename");
        String phone = call.getString("phone");
        String contactName = call.getString("contactName");

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

            boolean triedJid = false;
            String jidSkipReason = null;
            if (phone == null || phone.isEmpty()) {
                jidSkipReason = "no phone number available for this receipt";
            } else if (getPermissionState("contacts") != com.getcapacitor.PermissionState.GRANTED) {
                jidSkipReason = "Contacts permission not granted";
            } else {
                String failure = ensureContactSaved(phone, contactName);
                if (failure == null) {
                    intent.putExtra("jid", phone + "@s.whatsapp.net");
                    triedJid = true;
                    Log.i(TAG, "jid attempt: phone=" + phone + " contactName=" + contactName);
                } else {
                    jidSkipReason = failure;
                }
            }
            if (jidSkipReason != null) Log.w(TAG, "skipping jid: " + jidSkipReason);

            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("WhatsApp did not accept the share intent");
                return;
            }

            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("status", true);
            ret.put("triedJid", triedJid);
            if (jidSkipReason != null) ret.put("jidSkipReason", jidSkipReason);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not share to WhatsApp: " + e.getMessage(), e);
        }
    }

    /**
     * Null once `phone` is confirmed present in this phone's own Contacts
     * app -- already there, or just added. A non-null string names what
     * went wrong, surfaced all the way up to the share result and logged --
     * the caller treats any non-null return as "don't bother with jid,"
     * never as a reason to fail the whole share.
     */
    private String ensureContactSaved(String phone, String contactName) {
        try {
            if (contactExists(phone)) {
                Log.i(TAG, "contact already exists for " + phone);
                return null;
            }
            String name = (contactName != null && !contactName.isEmpty()) ? contactName : phone;
            String insertFailure = insertMinimalContact(phone, name);
            if (insertFailure != null) return insertFailure;
            Log.i(TAG, "saved new contact \"" + name + "\" for " + phone);
            // Real, unconfirmed risk (not yet proven, only suspected): a
            // contact inserted this same instant may not be visible to
            // WhatsApp's own jid-matching yet if it keeps a synced copy of
            // Contacts rather than querying live -- if jid keeps getting
            // ignored specifically on a donor/customer's *first ever*
            // share (but works on repeat shares to someone already in
            // Contacts, like the adb-tested "amir meera"), this timing gap
            // is the next thing to test, not another permissions dead end.
            return null;
        } catch (Exception e) {
            String msg = "ensureContactSaved threw: " + e;
            Log.e(TAG, msg, e);
            return msg;
        }
    }

    private boolean contactExists(String phone) {
        Uri lookupUri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phone));
        try (Cursor cursor = getContext().getContentResolver().query(
            lookupUri, new String[]{ ContactsContract.PhoneLookup._ID }, null, null, null
        )) {
            return cursor != null && cursor.getCount() > 0;
        }
    }

    /** Standard three-row RawContacts/StructuredName/Phone batch insert, applied atomically. Null on success. */
    private String insertMinimalContact(String phone, String name) {
        ArrayList<ContentProviderOperation> ops = new ArrayList<>();
        ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
            .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
            .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
            .build());
        ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
            .build());
        ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
            .build());
        try {
            getContext().getContentResolver().applyBatch(ContactsContract.AUTHORITY, ops);
            return null;
        } catch (RemoteException | OperationApplicationException e) {
            String msg = "applyBatch failed: " + e;
            Log.e(TAG, msg, e);
            return msg;
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
