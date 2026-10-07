import { SITE } from '@/lib/constants'

// Security notice sent after a successful in-session password change (not
// a reset) -- the "if this wasn't you" line matters here specifically,
// since unlike a reset link, nothing about this flow itself proves it was
// really the account owner (someone already signed in on a shared/left-
// open device could change it) -- this is the after-the-fact signal a
// real owner would need to notice and react.
// tenantName: whichever tenant's account this is -- never read from the
// global SITE constant (shared across every tenant's logins).
export function passwordChangedEmail(name: string, tenantName: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${tenantName}</h1>
    <p style="font-size: 13px; color: #666; margin: 2px 0 0;">${SITE.committee}</p>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Your password was changed</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Hi ${name || 'there'}, this confirms the password on your ${tenantName} account was just changed.
  </p>
  <div style="background: #fff8e6; border: 1px solid #f0d98c; border-radius: 8px; padding: 14px 18px; margin: 24px 0;">
    <p style="font-size: 13.5px; color: #6b5200; line-height: 20px; margin: 0;">
      If you didn't make this change, contact the committee immediately at
      <a href="${SITE.whatsappLink}" style="color: #6b5200; font-weight: 600;">${SITE.whatsapp}</a> — someone else may have access to your account.
    </p>
  </div>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    یہ تصدیق کرتا ہے کہ آپ کے <span style="direction: ltr; unicode-bidi: embed;">${tenantName}</span> اکاؤنٹ کا پاس ورڈ ابھی تبدیل کیا گیا ہے۔ اگر یہ تبدیلی آپ نے نہیں کی تو براہِ کرم فوری طور پر کمیٹی سے رابطہ کریں۔
  </p>
</div>`.trim()
}
