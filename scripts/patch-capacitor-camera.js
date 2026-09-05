// @capacitor/camera's own Android source (LegacyCameraFlow.java) gates
// launching the camera on `takePictureIntent.resolveActivity(...) != null`
// before ever trying to start it. That check is documented (Capacitor
// issue #3627, and multiple independent reports) to return a false
// negative on real devices — Google Pixel among them, confirmed live on
// a Pixel 4a with a fully working stock Camera app — even with the
// correct `<queries>` package-visibility declaration in this app's own
// AndroidManifest.xml. The fix used everywhere this bug is reported: skip
// the resolveActivity() pre-check and just attempt to start the camera
// intent, catching ActivityNotFoundException for the one real case that
// pre-check was ever guarding against.
//
// This lives outside node_modules (which npm install can wipe/replace at
// any time) as a small idempotent postinstall patch, run automatically
// after every `npm install` — see package.json's own "postinstall"
// script. Deliberately NOT patch-package: generating a patch against this
// exact package produced a 125,000-line diff (almost certainly a
// line-ending mismatch between the installed copy and patch-package's
// own re-fetched "clean" reference), which is unreviewable and not
// something to commit. A direct, targeted string replace against the
// one method that actually needs to change is both smaller and auditable.

const fs = require('fs')
const path = require('path')

const target = path.join(
  __dirname, '..', 'node_modules', '@capacitor', 'camera', 'android', 'src', 'main', 'java',
  'com', 'capacitorjs', 'plugins', 'camera', 'LegacyCameraFlow.java'
)

if (!fs.existsSync(target)) {
  console.log('[patch-capacitor-camera] @capacitor/camera not installed, skipping (fine on web-only installs)')
  process.exit(0)
}

const source = fs.readFileSync(target, 'utf8')
const marker = 'PATCHED (dhab-pari'
if (source.includes(marker)) {
  console.log('[patch-capacitor-camera] already patched, skipping')
  process.exit(0)
}

const needle = `            if (takePictureIntent.resolveActivity(context.getPackageManager()) != null) {
                // If we will be saving the photo, send the target file along
                try {
                    String appId = this.appId;
                    File photoFile = CameraUtils.createImageFile(activity);
                    imageFileSavePath = photoFile.getAbsolutePath();
                    // TODO: Verify provider config exists
                    imageFileUri = FileProvider.getUriForFile(activity, appId + ".fileprovider", photoFile);
                    takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, imageFileUri);
                    takePictureIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Exception ex) {
                    call.reject(IMAGE_FILE_SAVE_ERROR, ex);
                    return;
                }

                activityStarter.startActivityForResult(call, takePictureIntent, "processCameraImage");
            } else {
                call.reject(NO_CAMERA_ACTIVITY_ERROR);
            }`

const replacement = `            // PATCHED (dhab-pari, see scripts/patch-capacitor-camera.js): the
            // stock resolveActivity() pre-check here is a documented false
            // negative on some real devices (Google Pixel among them) even
            // with a correct <queries> declaration — skip it and just try
            // to start the activity, catching the one real failure case.
            {
                // If we will be saving the photo, send the target file along
                try {
                    String appId = this.appId;
                    File photoFile = CameraUtils.createImageFile(activity);
                    imageFileSavePath = photoFile.getAbsolutePath();
                    // TODO: Verify provider config exists
                    imageFileUri = FileProvider.getUriForFile(activity, appId + ".fileprovider", photoFile);
                    takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, imageFileUri);
                    takePictureIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Exception ex) {
                    call.reject(IMAGE_FILE_SAVE_ERROR, ex);
                    return;
                }

                try {
                    activityStarter.startActivityForResult(call, takePictureIntent, "processCameraImage");
                } catch (android.content.ActivityNotFoundException ex) {
                    // Deliberately a DIFFERENT string than the original
                    // NO_CAMERA_ACTIVITY_ERROR ("Unable to resolve camera
                    // activity") — the whole point of this patch was
                    // removing the resolveActivity() pre-check that produced
                    // that exact message, so if a real device still shows
                    // that old text after this patch is live, the build the
                    // device is running isn't actually patched (a stale
                    // install/cache problem, not this code). This message
                    // means the OS itself refused to start the intent even
                    // when actually attempted — a genuinely different,
                    // deeper problem than a resolveActivity() false negative.
                    call.reject("No app responded to the camera intent when actually launched (not a pre-check false negative)");
                }
            }`

if (!source.includes(needle)) {
  console.error('[patch-capacitor-camera] FAILED: expected source block not found — @capacitor/camera likely changed version/shape, patch needs updating by hand')
  process.exit(1)
}

fs.writeFileSync(target, source.replace(needle, replacement))
console.log('[patch-capacitor-camera] applied')
