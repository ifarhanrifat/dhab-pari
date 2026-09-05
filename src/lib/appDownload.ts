// Public download URL for the native Android app (APK) — uploaded to
// the existing public `attachments` Supabase Storage bucket (the same
// bucket other public files in this app already live in). See android/
// for the Capacitor project this gets built from, and CLAUDE.md/memory
// for the release-signing setup (dhabpari-release.keystore) —
// rebuilding requires JDK 21 (`JAVA_HOME=... ./gradlew assembleRelease`
// from android/), not whatever JDK is the machine's system default. Do
// a `clean` build after touching anything under node_modules/@capacitor
// (including scripts/patch-capacitor-camera.js's own postinstall patch)
// — Gradle's incremental build has been seen to silently keep a stale
// compiled copy of a capacitor-* module otherwise.
//
// The filename itself is now versioned (dhab-pari-v8.apk, not
// dhab-pari.apk?v=8) — a real report came back with a rebuilt,
// re-uploaded, hash-verified-fresh file still installing as the OLD
// version (Settings > Apps showed the previous versionName), on a link
// that had already been fetched before under the old ?v= number. A
// query-string cache-buster only works if whatever's in the middle
// actually keys its cache on the full URL including the query string —
// a mobile carrier's transparent proxy, a CDN edge tier, or the phone's
// own browser cache can all coalesce by path alone and silently ignore
// the query entirely. A genuinely new path can't hit any of those stale
// entries no matter how they key their cache, because nothing has ever
// fetched that exact path before. APK_VERSION must still match
// android/app/build.gradle's versionCode/versionName on every rebuild —
// bump all three together, and upload the new build to the new
// `app/dhab-pari-v${N}.apk` path rather than overwriting the old one.
const APK_VERSION = 8
export const APK_DOWNLOAD_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/attachments/app/dhab-pari-v${APK_VERSION}.apk`
