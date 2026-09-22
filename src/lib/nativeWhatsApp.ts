'use client'

// True "attach the file directly into WhatsApp" only exists once this app is
// running inside the native Android shell -- see WhatsAppSharePlugin.java for
// why: no browser API can hand a file to another site's composer, which is
// exactly why receiptExport.ts's web fallback only ever manages a
// clipboard-copy + deep link (and why a PDF, which can't even be
// clipboard-pasted, always had to be "downloaded, please attach manually").
// WhatsAppSharePlugin fires an explicit-package ACTION_SEND intent instead,
// so WhatsApp opens with the file *already attached*, and it works for PDF
// exactly the same as PNG.
//
// Landing directly in the right contact's chat (not WhatsApp's own picker)
// is a bonus on top of that, real device-confirmed on 2026-09-22: WhatsApp's
// undocumented "jid" extra only works when that number is already saved in
// this phone's own Contacts app, so the plugin checks/adds it first (a real
// Contacts-app permission and side effect, approved before building). When
// that isn't possible -- permission refused, or number can't be resolved --
// it still falls back to plain attach + WhatsApp's own picker.
//
// This requires a rebuilt, reinstalled APK (native Java code, not something
// the live website can push on its own -- see capacitor.config.ts's own
// comment on that split). Until that build is installed, shareFileToWhatsApp
// always resolves false and callers fall back to the existing web flow,
// which keeps working exactly as before.

interface WhatsAppSharePlugin {
  isAvailable(): Promise<{ available: boolean }>
  shareFile(options: { base64Data: string; mimeType: string; filename: string; phone?: string; contactName?: string }): Promise<{ status: boolean; triedJid: boolean; jidSkipReason?: string }>
}

export interface NativeShareResult {
  attached: boolean
  /** true only when the jid attempt was actually made (contact confirmed/saved) -- WhatsApp opened straight to that chat, not its own picker. */
  triedJid: boolean
  /** Set when triedJid is false and a phone number was given -- why jid wasn't attempted, straight from the plugin. Surfaced in the toast so this is diagnosable without a connected device. */
  jidSkipReason?: string
  /**
   * Real timing breakdown (ms), added after a report of "takes too long to
   * get to WhatsApp" with no way to tell whether that's the render, the
   * base64 encode, the JS<->native bridge transfer of a (possibly multi-MB)
   * base64 string, or the native side's own contact lookup/insert -- rather
   * than guess which one to optimize, measure all of them and surface the
   * total in the toast so this is diagnosable from the reported number
   * alone, no connected device required.
   */
  timingMs?: { base64Encode: number; nativeBridgeCall: number; total: number; blobBytes: number }
}

// Duplicated from receiptExport.ts's normalizePakPhone rather than imported --
// that file dynamically imports this one mid-function, and this one-liner
// isn't worth the circular-import subtlety of importing back.
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  return digits
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // Strip the "data:<mime>;base64," prefix -- the plugin only wants raw base64.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function shareFileToWhatsApp(blob: Blob, filename: string, mimeType: string, phone?: string | null, contactName?: string | null): Promise<NativeShareResult> {
  const notAttached: NativeShareResult = { attached: false, triedJid: false }
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return notAttached

  const WhatsAppShare = registerPlugin<WhatsAppSharePlugin>('WhatsAppShare')
  const { available } = await WhatsAppShare.isAvailable()
  if (!available) {
    // Expected on a device with neither WhatsApp nor WhatsApp Business
    // installed -- shareReceipt() falls back to the web flow silently by
    // design, but this line makes that an intentional, visible skip in
    // logcat/remote-debug rather than indistinguishable from a real failure.
    console.warn('[WhatsAppShare] neither WhatsApp nor WhatsApp Business found; falling back to web share')
    return notAttached
  }

  try {
    const start = performance.now()
    const base64Data = await blobToBase64(blob)
    const afterEncode = performance.now()
    const normalized = phone ? normalizePhone(phone) : null
    const result = await WhatsAppShare.shareFile({
      base64Data, mimeType, filename,
      phone: normalized ?? undefined,
      contactName: contactName ?? undefined,
    })
    const afterBridge = performance.now()
    const timingMs = {
      base64Encode: Math.round(afterEncode - start),
      nativeBridgeCall: Math.round(afterBridge - afterEncode),
      total: Math.round(afterBridge - start),
      blobBytes: blob.size,
    }
    console.info('[WhatsAppShare] native share fired', result, timingMs)
    return { attached: true, triedJid: result.triedJid, jidSkipReason: result.jidSkipReason, timingMs }
  } catch (err) {
    // A real failure (bridge error, file write, intent rejected) -- distinct
    // from "not available" above. Logged so a report of "still falling back"
    // is diagnosable from a connected device instead of another guess.
    console.error('[WhatsAppShare] native share failed, falling back to web share:', err)
    return notAttached
  }
}
