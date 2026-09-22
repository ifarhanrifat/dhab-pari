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
  shareFile(options: { base64Data: string; mimeType: string; filename: string }): Promise<{ status: boolean }>
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

export async function shareFileToWhatsApp(blob: Blob, filename: string, mimeType: string): Promise<boolean> {
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
    await WhatsAppShare.shareFile({ base64Data, mimeType, filename })
    return true
  } catch (err) {
    // A real failure (bridge error, file write, intent rejected) -- distinct
    // from "not available" above. Logged so a report of "still falling back"
    // is diagnosable from a connected device instead of another guess.
    console.error('[WhatsAppShare] native share failed, falling back to web share:', err)
    return false
  }
}
