'use client'

// window.print() inside the app's WebView does nothing on Android -- see
// PrintPlugin.java for why. These call the native PrintManager-backed
// plugin instead when running in the native shell; receiptExport.ts falls
// back to the existing iframe/window.print() web flow whenever a function
// here resolves false (not native, or the plugin call itself failed),
// exactly like nativeWhatsApp.ts's own shareFileToWhatsApp fallback
// contract.
//
// Requires a rebuilt, reinstalled APK (native Java code, not something the
// live website can push on its own -- see nativeWhatsApp.ts's own header
// comment on that same split). Until that build is installed, both
// functions below always resolve false and callers fall back to the
// existing web flow, which keeps working exactly as before.

interface NativePrintPlugin {
  printHtml(options: { html: string; jobName: string }): Promise<void>
  printPdf(options: { base64Data: string; jobName: string }): Promise<void>
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function printHtmlNatively(html: string, jobName: string): Promise<boolean> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return false
  try {
    const NativePrint = registerPlugin<NativePrintPlugin>('NativePrint')
    await NativePrint.printHtml({ html, jobName })
    return true
  } catch (err) {
    console.error('[NativePrint] printHtml failed, falling back to web print:', err)
    return false
  }
}

export async function printPdfNatively(blob: Blob, jobName: string): Promise<boolean> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return false
  try {
    const base64Data = await blobToBase64(blob)
    const NativePrint = registerPlugin<NativePrintPlugin>('NativePrint')
    await NativePrint.printPdf({ base64Data, jobName })
    return true
  } catch (err) {
    console.error('[NativePrint] printPdf failed, falling back to web print:', err)
    return false
  }
}
