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

export async function nodeToPdfBlob(node: HTMLElement): Promise<Blob> {
  const canvas = await renderNodeToCanvas(node)
  const { jsPDF } = await import('jspdf')
  const imgData = canvas.toDataURL('image/png')
  const pxToMm = 25.4 / 96
  const widthMm = canvas.width * pxToMm / 2
  const heightMm = canvas.height * pxToMm / 2
  const pdf = new jsPDF({
    orientation: widthMm > heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [widthMm, heightMm],
  })
  pdf.addImage(imgData, 'PNG', 0, 0, widthMm, heightMm)

  // html2canvas flattens the document to pixels, which kills every hyperlink —
  // the Facebook/WhatsApp/Donate row and the helpline numbers all came out dead
  // in the exported file. Re-attach them as real PDF link annotations, mapped
  // from each anchor's on-screen box into page millimetres. The visual stays a
  // raster; the tappable regions come back.
  const base = node.getBoundingClientRect()
  const mmPerPx = base.width > 0 ? widthMm / base.width : 0
  if (mmPerPx > 0) {
    node.querySelectorAll('a[href]').forEach((el) => {
      const href = (el as HTMLAnchorElement).href
      if (!href || href.startsWith('blob:') || href.startsWith('javascript:')) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      pdf.link((r.left - base.left) * mmPerPx, (r.top - base.top) * mmPerPx, r.width * mmPerPx, r.height * mmPerPx, { url: href })
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
 * Best available way to get the document into a WhatsApp chat, in order:
 *
 *  1. OS share sheet with the file attached (`navigator.share({ files })`) —
 *     on Android/iOS this hands WhatsApp the real file, no download step. This
 *     is the only true "attach directly" a web page has.
 *  2. Clipboard — copy the PNG, open the chat, user presses Ctrl/Cmd+V. WhatsApp
 *     Web accepts a pasted image as an attachment, so this is one keystroke away
 *     from the same result on desktop.
 *  3. Download + open the chat, and tell them to attach it.
 *
 * There is deliberately no fourth option: wa.me/api.whatsapp.com accept text
 * only, and no browser API can push a file into another site's composer. Native
 * desktop apps manage it because they drive the OS, not a sandboxed page.
 */
export async function shareReceipt({ blob, filename, mime, phone, message, clipboardBlob }: ShareOptions): Promise<'shared' | 'copied' | 'downloaded'> {
  const file = new File([blob], filename, { type: mime })

  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: message })
      return 'shared'
    } catch {
      // user cancelled or share failed — fall through
    }
  }

  const copied = clipboardBlob ? await copyImageToClipboard(clipboardBlob) : false
  if (!copied) downloadBlob(blob, filename)

  if (phone) {
    const intl = normalizePakPhone(phone)
    if (intl) {
      const note = copied
        ? ' (Image copied — press Ctrl+V / Cmd+V here to attach it.)'
        : ' (File downloaded — please attach it to this chat.)'
      window.open(`https://wa.me/${intl}?text=${encodeURIComponent((message ?? 'Your receipt is attached.') + note)}`, '_blank')
    }
  }

  return copied ? 'copied' : 'downloaded'
}
