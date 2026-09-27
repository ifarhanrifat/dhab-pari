import { SITE } from '@/lib/constants'

// Real ask, 2026-09-27: switched from a clickable one-time link to a
// plain code the user types in — see migration 514's comment for why
// (link pre-fetching by email scanners, and confusion over which of
// several emails is the current one, both silently killed the link
// approach in practice). A code has nothing for a scanner to consume and
// nothing ambiguous about "which one" — whichever code is in front of the
// user is the one they use.
export function portalPasswordResetCodeEmail(code: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${SITE.name}</h1>
    <p style="font-size: 13px; color: #666; margin: 2px 0 0;">${SITE.committee}</p>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Your password reset code</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Enter this code on the password reset page to choose a new password. It expires in 15 minutes.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; background: #f0faf6; border: 2px solid #1D9E75; color: #0d3b2e; letter-spacing: 8px; font-size: 32px; font-weight: 700; padding: 16px 24px; border-radius: 10px; font-family: monospace;">${code}</span>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't request this, you can safely ignore this email — your password won't change unless this code is used.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    نیا پاس ورڈ منتخب کرنے کے لیے یہ کوڈ پاس ورڈ ری سیٹ صفحے پر درج کریں۔ اس کی میعاد 15 منٹ میں ختم ہو جائے گی۔ اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کریں۔
  </p>
</div>`.trim()
}
