// Every AI photo-scan in the shop portal (my-shop's Add Stock scan,
// my-shop/sell's counter scan, BrandBuilderModal's new-brand scan) used
// to send the raw camera/gallery file straight to Gemini as base64, no
// resizing. That's fine for a small test image picked on a desktop
// browser, but a real phone's own camera or gallery photo is routinely
// 8-15MB at full sensor resolution — base64 adds ~33% on top of that,
// and the resulting multi-megabyte JSON body is slow (or on a weak
// mobile connection, prone to failing outright) to POST, which reads to
// the shopkeeper as a vague "couldn't read this image" failure with
// nothing pointing at the real cause. Downscaling + re-encoding through
// a canvas first fixes three things at once: it shrinks the payload to
// something that reliably survives a mobile upload, it always outputs
// plain JPEG regardless of the source file's own format/mimetype
// quirks (some Android content:// picker results report an unhelpful
// or empty File.type), and drawing an <img> to canvas normalizes EXIF
// orientation for free — modern Chromium/WebView already renders an
// <img> element pre-rotated per its own EXIF tag, and canvas.drawImage
// captures that already-corrected orientation, not the raw sensor bytes.
export function compressImageToBase64(file: File, maxDim = 1600, quality = 0.82): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width <= 0 || height <= 0) { reject(new Error('Empty image')); return }
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas not supported on this device')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      const base64 = dataUrl.split(',')[1]
      if (!base64) { reject(new Error('Could not encode image')); return }
      resolve({ base64, mimeType: 'image/jpeg' })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load the selected image')) }
    img.src = url
  })
}
