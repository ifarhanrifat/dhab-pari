
// Same code-not-link shape as portalPasswordResetEmail.ts, migration 521's
// own reasoning: whatsapp_number is where donation notifications and
// committee messages actually go, and had no confirmation step at all
// before this. Names the requested new number in the email itself so
// someone who didn't request this immediately sees which number it was.
// tenantName: whichever tenant's portal account this is -- never read
// from the global SITE constant (shared across every tenant's logins).
export function portalWhatsappChangeCodeEmail(code: string, newNumber: string, tenantName: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${tenantName}</h1>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Confirm your new WhatsApp number</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Someone requested changing your portal WhatsApp number to <strong style="direction: ltr; unicode-bidi: embed;">${newNumber}</strong>.
    Enter this code on the profile page to confirm it. It expires in 15 minutes.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; background: #f0faf6; border: 2px solid #1D9E75; color: #0d3b2e; letter-spacing: 8px; font-size: 32px; font-weight: 700; padding: 16px 24px; border-radius: 10px; font-family: monospace;">${code}</span>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't request this, ignore this email — your WhatsApp number won't change unless this code is used.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    کسی نے آپ کا پورٹل واٹس ایپ نمبر تبدیل کر کے <span style="direction: ltr; unicode-bidi: embed;">${newNumber}</span> کرنے کی درخواست کی ہے۔ اسے تصدیق کرنے کے لیے یہ کوڈ پروفائل صفحے پر درج کریں۔ اس کی میعاد 15 منٹ میں ختم ہو جائے گی۔ اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کریں۔
  </p>
</div>`.trim()
}
