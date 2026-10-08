import { SITE } from '@/lib/constants'

// Mirrors portalPasswordResetCodeEmail's reasoning (see migration 565) --
// a code instead of a clickable link, since a link gets silently consumed
// by email security scanners that pre-fetch everything in a new email
// before the real admin ever opens it. The link below is a plain path with
// no token in it at all, so there is nothing a scanner visiting it could
// burn -- it's just a shortcut to the page where the code is typed in.
// tenantName: the real committee this invite belongs to -- every tenant
// shares this one email, so the name is never read from the global SITE
// constant here (that would always say "Dhab Pari" regardless of which
// village actually sent the invite).
//
// tenantSlug: null for dhab-pari itself (stays on the apex domain, its
// long-standing default); every other tenant gets its own subdomain so
// the accept-invite page lands with the right x-tenant-id cookie set --
// see getTenantSlug()'s own comment for why this matters.
export function adminInviteCodeEmail(code: string, fullName: string, roleLabel: string, tenantName: string, tenantSlug: string | null) {
  const host = tenantSlug ? `${tenantSlug}.${SITE.domain}` : SITE.domain
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${tenantName}</h1>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">You've been invited as ${roleLabel}</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Hi ${fullName || 'there'}, you've been invited to the ${tenantName} admin portal. Enter this code on the accept-invite page to activate your account and choose a password. It expires in 60 minutes.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; background: #f0faf6; border: 2px solid #1D9E75; color: #0d3b2e; letter-spacing: 8px; font-size: 32px; font-weight: 700; padding: 16px 24px; border-radius: 10px; font-family: monospace;">${code}</span>
  </div>
  <div style="text-align: center; margin-bottom: 24px;">
    <a href="https://${host}/admin/accept-invite" style="color: #1D9E75; font-weight: 600; font-size: 14px;">Open the accept-invite page</a>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you weren't expecting this, you can ignore this email — no account is created unless this code is used.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    آپ کو <span style="direction: ltr; unicode-bidi: embed;">${tenantName}</span> ایڈمن پورٹل میں مدعو کیا گیا ہے۔ اپنا اکاؤنٹ فعال کرنے اور پاس ورڈ منتخب کرنے کے لیے یہ کوڈ accept-invite صفحے پر درج کریں۔ اس کی میعاد 60 منٹ میں ختم ہو جائے گی۔
  </p>
</div>`.trim()
}
