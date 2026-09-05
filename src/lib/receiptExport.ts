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

async function renderNodeToCanvas(node: HTMLElement): Promise<HTMLCanvasElement> {
  // html2canvas-pro (not the original html2canvas) — the original can't parse the
  // oklch()/lab() color functions Tailwind's theme emits and throws on every render.
  const { default: html2canvas } = await import('html2canvas-pro')
  return html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
}

export async function nodeToPngBlob(node: HTMLElement): Promise<Blob> {
  const canvas = await renderNodeToCanvas(node)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to render PNG'))), 'image/png')
  })
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

export async function nodeToPdfBlob(node: HTMLElement, page: PdfPageSize = 'content'): Promise<Blob> {
  const canvas = await renderNodeToCanvas(node)
  const { jsPDF } = await import('jspdf')
  const imgData = canvas.toDataURL('image/png')
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
  for (let i = 0; i < pageCount; i++) {
    if (i > 0) pdf.addPage([pageW, pageH], pageW > pageH ? 'landscape' : 'portrait')
    pdf.addImage(imgData, 'PNG', offsetX, -i * pageH, drawW, drawH)
  }

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

  return pdf.output('blob')
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
  message?: string
  /** PNG used for the clipboard fallback when the OS share sheet isn't available. */
  clipboardBlob?: Blob | null
}

/**
 * Puts the document in front of a WhatsApp chat. Every button that calls this
 * is labelled WhatsApp, so this goes to WhatsApp and nowhere else:
 *
 *  1. Clipboard — copy the PNG, open the chat, user presses Ctrl/Cmd+V.
 *     WhatsApp Web accepts a pasted image, so this is one keystroke from done.
 *  2. Download + open the chat, and tell them to attach it.
 *
 * This used to lead with the OS share sheet (`navigator.share({ files })`),
 * which does hand WhatsApp the real file on a phone — but it is a *chooser*:
 * it offers every app on the device, so a button that reads "Share via
 * WhatsApp" could just as easily end in Gmail or Drive, and on a shared
 * committee phone the wrong app is a real way to leak a consumer's receipt.
 * A button has to do what it says, so the sheet is gone.
 *
 * There is deliberately no third option: wa.me/api.whatsapp.com accept text
 * only, and no browser API can push a file into another site's composer. Native
 * desktop apps manage it because they drive the OS, not a sandboxed page.
 */
export async function shareReceipt({ blob, filename, phone, message, clipboardBlob }: ShareOptions): Promise<'copied' | 'downloaded'> {
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

  return copied ? 'copied' : 'downloaded'
}
