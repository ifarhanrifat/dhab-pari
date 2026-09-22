'use client'

// True "attach the file directly into WhatsApp" only exists once this app is
// running inside the native Android shell -- see WhatsAppSharePlugin.java for
// why: no browser API can hand a file to another site's composer, which is
// exactly why receiptExport.ts's web fallback only ever manages a
// clipboard-copy + deep link (and why a PDF, which can't even be
// clipboard-pasted, always had to be "downloaded, please attach manually").
// WhatsAppSharePlugin fires an explicit-package ACTION_SEND intent instead,
// so WhatsApp opens with the file *already attached* and its own contact
// picker showing -- the same "Share to WhatsApp" pattern most native apps
// use, and it works for PDF exactly the same as PNG.
//
// This requires a rebuilt, reinstalled APK (native Java code, not something
// the live website can push on its own -- see capacitor.config.ts's own
// comment on that split). Until that build is installed, shareFileToWhatsApp
// always resolves false and callers fall back to the existing web flow,
// which keeps working exactly as before.

interface WhatsAppSharePlugin {
  isAvailable(): Promise<{ available: boolean }>
  shareFile(options: { base64Data: string; mimeType: string; filename: string; phone?: string }): Promise<{ status: boolean; triedJid: boolean }>
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

export async function shareFileToWhatsApp(blob: Blob, filename: string, mimeType: string, phone?: string | null): Promise<boolean> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return false

  const WhatsAppShare = registerPlugin<WhatsAppSharePlugin>('WhatsAppShare')
  const { available } = await WhatsAppShare.isAvailable()
  if (!available) {
    // Expected on a device with neither WhatsApp nor WhatsApp Business
    // installed -- shareReceipt() falls back to the web flow silently by
    // design, but this line makes that an intentional, visible skip in
    // logcat/remote-debug rather than indistinguishable from a real failure.
    console.warn('[WhatsAppShare] neither WhatsApp nor WhatsApp Business found; falling back to web share')
    return false
  }

  try {
    const base64Data = await blobToBase64(blob)
    // jid is undocumented and known-unreliable (WhatsApp broke this for many
    // users around 2023) -- WhatsAppSharePlugin tries it when a phone is
    // given, but there's no way to detect an in-WhatsApp rejection from
    // here, so this is genuinely experimental per-device, not a confirmed
    // capability. Logged either way so the outcome is checkable on a real
    // device instead of guessed at.
    const normalized = phone ? normalizePhone(phone) : null
    const result = await WhatsAppShare.shareFile({ base64Data, mimeType, filename, phone: normalized ?? undefined })
    console.info('[WhatsAppShare] native share fired', result)
    return true
  } catch (err) {
    // A real failure (bridge error, file write, intent rejected) -- distinct
    // from "not available" above. Logged so a report of "still falling back"
    // is diagnosable from a connected device instead of another guess.
    console.error('[WhatsAppShare] native share failed, falling back to web share:', err)
    return false
  }
}
