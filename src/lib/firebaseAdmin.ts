import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'

// Server-only — the private key here grants full send access to the
// project's Firebase Cloud Messaging. Never import this from a client
// component or any code that ships to the browser.
let app: App | null = null

export function getFirebaseAdminApp(): App | null {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return null

  if (app) return app
  const existing = getApps()[0]
  if (existing) { app = existing; return app }

  app = initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // The .env value keeps its literal \n escapes (a real newline inside
      // a .env file breaks parsing) — undo that here, once, at the source.
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  })
  return app
}

export function getFirebaseMessaging() {
  const a = getFirebaseAdminApp()
  return a ? getMessaging(a) : null
}
