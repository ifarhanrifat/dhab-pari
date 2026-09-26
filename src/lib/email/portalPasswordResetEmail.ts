import { SITE } from '@/lib/constants'

// Plain inline-styled table-free HTML — deliberately simple rather than a
// full design pass: email clients strip most CSS, and this is a one-button
// transactional message, not a marketing send.
export function portalPasswordResetEmail(resetLink: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${SITE.name}</h1>
    <p style="font-size: 13px; color: #666; margin: 2px 0 0;">${SITE.committee}</p>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Reset Your Password</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    We received a request to reset the password for your Dhab Pari portal account.
    Click the button below to choose a new one. This link expires in 1 hour.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <a href="${resetLink}" style="display: inline-block; background: #1D9E75; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">Reset Password</a>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't request this, you can safely ignore this email — your password won't change.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    آپ کے ڈھاب پڑی پورٹل اکاؤنٹ کے پاس ورڈ کی بحالی کی درخواست موصول ہوئی ہے۔ نیا پاس ورڈ منتخب کرنے کے لیے اوپر دیے گئے بٹن پر کلک کریں۔ اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کریں۔
  </p>
</div>`.trim()
}
