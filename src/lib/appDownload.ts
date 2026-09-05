// Public download URL for the native Android app (APK) — uploaded to
// the existing public `attachments` Supabase Storage bucket (the same
// bucket other public files in this app already live in) at a stable
// path, so re-uploading a newer build overwrites the same object and
// this URL never has to change. See android/ for the Capacitor project
// this gets built from, and CLAUDE.md/memory for the release-signing
// setup (dhabpari-release.keystore) — rebuilding requires JDK 21
// (`JAVA_HOME=... ./gradlew assembleRelease` from android/), not
// whatever JDK is the machine's system default.
//
// APK_VERSION must match android/app/build.gradle's versionCode/
// versionName on every rebuild, and is appended as a cache-busting
// query param — the storage object itself is served `no-cache`, but a
// phone's browser/download manager reusing the exact same filename can
// still silently hand back a previously-downloaded copy instead of
// re-fetching (this actually happened once: a "reinstall" ran on a
// pre-native-settings build and hit "plugin not implemented"). Bump
// this any time the APK is rebuilt, even if the filename doesn't change.
const APK_VERSION = 6
export const APK_DOWNLOAD_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/attachments/app/dhab-pari.apk?v=${APK_VERSION}`
