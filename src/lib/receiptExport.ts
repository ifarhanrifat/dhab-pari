export type ReceiptFormat = 'pdf' | 'png'

const FORMAT_KEY = 'dp_receipt_format'

export function getPreferredFormat(): ReceiptFormat {
  if (typeof window === 'undefined') return 'pdf'
  return (window.localStorage.getItem(FORMAT_KEY) as ReceiptFormat) || 'pdf'
}

export function setPreferredFormat(format: ReceiptFormat) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(FORMAT_KEY, format)
}

/** A4 sheet printer vs 58/80mm Bluetooth thermal roll. */
export type SlipPrintTarget = 'a4' | 'thermal'

const SLIP_TARGET_KEY = 'dp_slip_print_target'

// Remembered per person, per device — a field collector carrying a Bluetooth
// printer and an accountant at an office A4 machine share one login-level
// setting but need different defaults. The Settings value (slip_format_water /
// slip_format_donor) is the committee-wide starting point; whatever this user
// last chose overrides it for them, and nobody else is affected.
export function getPreferredSlipTarget(): SlipPrintTarget | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(SLIP_TARGET_KEY)
  return v === 'a4' || v === 'thermal' ? v : null
}

export function setPreferredSlipTarget(target: SlipPrintTarget) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SLIP_TARGET_KEY, target)
}

// Real report (2026-09-22): render went from 7s to 19.9s on the SAME
// device after the logo data-URI fix that was supposed to bring it down --
// the earlier "render Xms" toast number was html2canvas() and everything
// around it lumped into one bucket, so there was no way to tell whether
// the logo theory ever actually held, or something else entirely is slow.
// Module-level rather than threaded through every buildBlob() call site
// (ReceiptModal, the bill invoice page, my-shop/customers) -- this is
// temporary diagnostic instrumentation, not permanent plumbing; the
// caller reads it immediately after its own nodeToPngBlob/nodeToPdfBlob
// call resolves, before anything else can overwrite it.
export let lastRenderTiming: {
  html2canvasMs: number
  postProcessMs: number
  // PDF-only breakdown of postProcessMs, added 2026-09-23 after a report
  // (post 13027ms) came back essentially unchanged despite the jsPDF
  // preload fix -- proof the import was never the real cost. These pin
  // down which specific step inside "post" actually owns the time instead
  // of guessing again.
  toDataUrlMs?: number
  addImageMs?: number
  outputMs?: number
} | null = null

async function renderNodeToCanvas(node: HTMLElement): Promise<HTMLCanvasElement> {
  // html2canvas-pro (not the original html2canvas) — the original can't parse the
  // oklch()/lab() color functions Tailwind's theme emits and throws on every render.
  const { default: html2canvas } = await import('html2canvas-pro')
  const start = performance.now()
  const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
  lastRenderTiming = { html2canvasMs: Math.round(performance.now() - start), postProcessMs: 0 }
  return canvas
}

export async function nodeToPngBlob(node: HTMLElement): Promise<Blob> {
  const canvas = await renderNodeToCanvas(node)
  const start = performance.now()
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to render PNG'))), 'image/png')
  })
  if (lastRenderTiming) lastRenderTiming.postProcessMs = Math.round(performance.now() - start)
  return blob
}

/**
 * What kind of *page* the PDF gets, which is a separate question from how the
 * node was laid out:
 *
 *   'a4'      — a real 210×297mm sheet, the content placed on it.
 *   'content' — the page is cut to whatever the node rendered to.
 *
 * 'content' is right for a thermal roll and only for a thermal roll: a roll has
 * a fixed printable width and no page length at all, so "the page is as long as
 * the receipt" is a truthful description of the paper. It is wrong for a sheet
 * printer, which has a page length whether the document uses it or not.
 */
export type PdfPageSize = 'a4' | 'content'

const A4_W_MM = 210
const A4_H_MM = 297

// Real cause found (2026-09-22), not the logo: a report of "post 13041ms"
// vs an earlier "post 229ms" for the exact same work is the signature of a
// network fetch, not processing -- `await import('jspdf')` used to sit
// *inside* the timed postProcess window, so its dynamic-import chunk fetch
// (over whatever mobile connection this session's real numbers make plain
// is not fast or consistent) was masquerading as "PDF building is slow."
// Called eagerly, fire-and-forget, as soon as a page/modal that might
// export a PDF mounts -- by the time someone actually taps Share, this
// chunk is already resident and the real await below resolves instantly
// from the module cache instead of hitting the network on the critical path.
let jsPdfPreload: Promise<typeof import('jspdf')> | null = null
export function preloadJsPdf() {
  if (!jsPdfPreload) jsPdfPreload = import('jspdf')
}

export async function nodeToPdfBlob(node: HTMLElement, page: PdfPageSize = 'content'): Promise<Blob> {
  const canvas = await renderNodeToCanvas(node)
  const postProcessStart = performance.now()
  preloadJsPdf()
  const { jsPDF } = await jsPdfPreload!
  const toDataUrlStart = performance.now()
  const imgData = canvas.toDataURL('image/png')
  const toDataUrlMs = Math.round(performance.now() - toDataUrlStart)
  const pxToMm = 25.4 / 96
  // renderNodeToCanvas rasterizes at scale 2, so halve back to CSS pixels
  // before converting — these are the node's own on-screen millimetres.
  const contentW = canvas.width * pxToMm / 2
  const contentH = canvas.height * pxToMm / 2

  // The A4 button used to be a label, not a page size. Every export took this
  // branch: format [contentW, contentH] makes a *custom* page exactly as tall
  // as whatever was rendered, so a short receipt produced a 210×270mm page and
  // a long bill a 210×292mm one — measured, not guessed. A print dialog handed
  // a custom page either scales it onto the real sheet or centres it, which is
  // why "the A4 print is not A4 size at all". The page is the sheet now, and
  // the content sits on it.
  const isA4 = page === 'a4'
  const pageW = isA4 ? A4_W_MM : contentW
  const pageH = isA4 ? A4_H_MM : contentH

  // Natural size wherever it fits — a bill that only fills two thirds of the
  // sheet should leave the last third blank, exactly like every printed
  // invoice does; stretching it to the paper would just make the type grow
  // with the shortness of the document. Two things override that:
  //
  //  - Wider than the sheet is never acceptable, so width fits first. The
  //    slip is built at 794px = 210.08mm, a hair over A4, so this trims a
  //    fraction of a percent rather than doing real work — but a legacy skin
  //    or a future wider document would otherwise lose its right edge.
  //  - A document a little taller than one page shrinks to fit instead of
  //    spilling a 5mm sliver of footer onto a second sheet. Past that (8%)
  //    the shrink would start costing legibility, so it genuinely paginates.
  const fit = Math.min(1, pageW / contentW)
  let drawW = contentW * fit
  let drawH = contentH * fit
  if (drawH > pageH && drawH <= pageH * 1.08) {
    const squeeze = pageH / drawH
    drawW *= squeeze
    drawH *= squeeze
  }
  const pageCount = Math.max(1, Math.ceil(drawH / pageH - 1e-6))
  const offsetX = (pageW - drawW) / 2

  const pdf = new jsPDF({
    orientation: pageW > pageH ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [pageW, pageH],
  })
  // Top-anchored, centred across. Pages after the first place the same image
  // shifted up by a whole page, so each sheet shows its own band of it — the
  // standard way to paginate a raster, and the only one available here since
  // html2canvas has already flattened the document.
  const addImageStart = performance.now()
  for (let i = 0; i < pageCount; i++) {
    if (i > 0) pdf.addPage([pageW, pageH], pageW > pageH ? 'landscape' : 'portrait')
    pdf.addImage(imgData, 'PNG', offsetX, -i * pageH, drawW, drawH)
  }
  const addImageMs = Math.round(performance.now() - addImageStart)

  // html2canvas flattens the document to pixels, which kills every hyperlink —
  // the Facebook/WhatsApp/Donate row and the helpline numbers all came out dead
  // in the exported file. Re-attach them as real PDF link annotations, mapped
  // from each anchor's on-screen box into page millimetres. The visual stays a
  // raster; the tappable regions come back.
  //
  // The scale factor is drawW/base.width, not pageW/base.width: the page is no
  // longer necessarily the same size as the content drawn on it, so the boxes
  // have to follow the image, offset and all, or they would drift off their
  // own glyphs on any page that isn't a perfect 1:1 fit.
  const base = node.getBoundingClientRect()
  const mmPerPx = base.width > 0 ? drawW / base.width : 0
  if (mmPerPx > 0) {
    node.querySelectorAll('a[href]').forEach((el) => {
      const href = (el as HTMLAnchorElement).href
      if (!href || href.startsWith('blob:') || href.startsWith('javascript:')) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      const yAbs = (r.top - base.top) * mmPerPx
      // A link lives on the sheet its top edge landed on; pdf.link always
      // annotates the *current* page, so seek there first.
      const onPage = Math.min(pageCount, Math.max(1, Math.floor(yAbs / pageH) + 1))
      pdf.setPage(onPage)
      pdf.link(offsetX + (r.left - base.left) * mmPerPx, yAbs - (onPage - 1) * pageH, r.width * mmPerPx, r.height * mmPerPx, { url: href })
    })
  }

  if (lastRenderTiming) {
    lastRenderTiming.postProcessMs = Math.round(performance.now() - postProcessStart)
    lastRenderTiming.toDataUrlMs = toDataUrlMs
    lastRenderTiming.addImageMs = addImageMs
  }
  const outputStart = performance.now()
  const result = pdf.output('blob')
  if (lastRenderTiming) lastRenderTiming.outputMs = Math.round(performance.now() - outputStart)
  return result
}

/** Puts a PNG on the clipboard so it can be pasted straight into a chat.
 *  Returns false when the browser refuses (unsupported, or not a user gesture). */
export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

/**
 * Prints a blob (PDF) in an isolated, about:blank-hosted document instead of the live page.
 * Browsers inject the page's own URL into printed headers/footers — calling window.print()
 * on an actual admin route would leak internal URLs (and account UUIDs) onto anything printed
 * or handed to a consumer/donor. Printing a blob: document has no admin URL to leak.
 */
export function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    // Popup blocked — fall back to a plain download so the user can still print manually.
    downloadBlob(blob, 'document.pdf')
    return
  }
  win.addEventListener('load', () => {
    win.print()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })
}

/**
 * Prints a DOM node by cloning it into a fresh about:blank popup (with the app's own
 * stylesheets attached) and printing that instead of the live page. Used for large/complex
 * regions (e.g. a full statement table) where rasterizing via html2canvas is unreliable —
 * this also solves the same URL-leak problem as printBlob(), since about:blank carries no
 * admin route or account id into the printed output.
 */
export function printNodeInPopup(node: HTMLElement, title = 'Print') {
  const win = window.open('', '_blank')
  if (!win) return false

  const styleTags = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((el) => el.outerHTML)
    .join('\n')

  win.document.open()
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>${styleTags}</head><body>${node.outerHTML}</body></html>`)
  win.document.close()

  win.addEventListener('load', () => win.print())
  return true
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function normalizePakPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  return digits
}

interface ShareOptions {
  blob: Blob
  filename: string
  mime: string
  phone?: string | null
  /** Only used natively, to name a newly-saved contact when `phone` isn't already in the phone's Contacts app. */
  contactName?: string | null
  message?: string
  /**
   * PNG used for the clipboard fallback when native attach isn't available.
   * Lazy: a PDF share has to render this as a *separate* html2canvas pass
   * from the PDF itself, which is real, measurable time (the "WhatsApp
   * button takes forever" report) that's pure waste whenever native attach
   * succeeds and this never gets used at all. Only called if actually needed.
   */
  getClipboardBlob?: () => Promise<Blob | null>
}

/**
 * Puts the document in front of a WhatsApp chat. Every button that calls this
 * is labelled WhatsApp, so this goes to WhatsApp and nowhere else:
 *
 *  1. Native (Android app only) — WhatsAppSharePlugin fires an
 *     explicit-package ACTION_SEND intent, so WhatsApp opens with the file
 *     *already attached* and its own contact picker showing. Works for PDF
 *     exactly like PNG. See nativeWhatsApp.ts for why this only exists in
 *     the native shell, not a browser tab.
 *  2. Clipboard (web fallback) — copy the PNG, open the chat, user presses
 *     Ctrl/Cmd+V. WhatsApp Web accepts a pasted image, so this is one
 *     keystroke from done. PDF can't be clipboard-pasted at all, so this
 *     step only ever applies to PNG.
 *  3. Download + open the chat, and tell them to attach it.
 *
 * This used to lead with the OS share sheet (`navigator.share({ files })`),
 * which does hand WhatsApp the real file on a phone — but it is a *chooser*:
 * it offers every app on the device, so a button that reads "Share via
 * WhatsApp" could just as easily end in Gmail or Drive, and on a shared
 * committee phone the wrong app is a real way to leak a consumer's receipt.
 * A button has to do what it says, so the sheet went away in favour of step 2
 * — step 1's explicit-package intent doesn't have that problem (the target
 * is pinned to WhatsApp, never a chooser), which is what makes it safe to
 * bring back natively.
 *
 * On the web there is deliberately no way to attach a file directly:
 * wa.me/api.whatsapp.com accept text only, and no browser API can push a
 * file into another site's composer. Native desktop apps manage it because
 * they drive the OS, not a sandboxed page — which is exactly what step 1
 * does once this runs as a real Android app instead.
 */
export interface ShareResult {
  outcome: 'attached-direct' | 'attached' | 'copied' | 'downloaded'
  /** Only set when a phone was given but jid wasn't attempted -- straight from the plugin, so this is diagnosable from the toast alone. */
  jidSkipReason?: string
  /** Only set on a native attach -- the encode+bridge time from shareFileToWhatsApp(), passed through so a slow-share report can be diagnosed from the toast text alone. */
  nativeTimingMs?: { base64Encode: number; nativeBridgeCall: number; total: number; blobBytes: number }
}

export async function shareReceipt({ blob, filename, mime, phone, contactName, message, getClipboardBlob }: ShareOptions): Promise<ShareResult> {
  const { shareFileToWhatsApp } = await import('./nativeWhatsApp')
  const native = await shareFileToWhatsApp(blob, filename, mime, phone, contactName).catch(() => ({ attached: false, triedJid: false, jidSkipReason: undefined, timingMs: undefined }))
  if (native.attached) {
    return { outcome: native.triedJid ? 'attached-direct' : 'attached', jidSkipReason: native.jidSkipReason, nativeTimingMs: native.timingMs }
  }

  const clipboardBlob = getClipboardBlob ? await getClipboardBlob() : null
  const copied = clipboardBlob ? await copyImageToClipboard(clipboardBlob) : false
  if (!copied) downloadBlob(blob, filename)

  const note = copied
    ? ' (Image copied — press Ctrl+V / Cmd+V here to attach it.)'
    : ' (File downloaded — please attach it to this chat.)'
  const text = encodeURIComponent((message ?? 'Your receipt is attached.') + note)
  // With a number we open that consumer's chat; without one, wa.me's own chat
  // picker. Either way WhatsApp opens — never a generic share sheet, and never
  // nothing at all, which is what a missing number used to produce.
  const intl = phone ? normalizePakPhone(phone) : null
  window.open(intl ? `https://wa.me/${intl}?text=${text}` : `https://wa.me/?text=${text}`, '_blank')

  return { outcome: copied ? 'copied' : 'downloaded' }
}
