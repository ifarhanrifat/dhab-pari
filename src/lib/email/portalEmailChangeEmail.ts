
// Same code-not-link shape as portalWhatsappChangeEmail.ts. Sent to the
// NEW address being requested (proving control of it), not the current
// one — see migration 523's own comment for why that's the right way
// around for changing the identity anchor itself.
// tenantName: whichever tenant's portal account this is -- never read
// from the global SITE constant (shared across every tenant's logins).
export function portalEmailChangeCodeEmail(code: string, tenantName: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${tenantName}</h1>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Confirm this email for your portal account</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Someone requested making this address the login email for a ${tenantName} portal account.
    Enter this code on the profile page to confirm it. It expires in 15 minutes.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; background: #f0faf6; border: 2px solid #1D9E75; color: #0d3b2e; letter-spacing: 8px; font-size: 32px; font-weight: 700; padding: 16px 24px; border-radius: 10px; font-family: monospace;">${code}</span>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't request this, ignore this email — nothing changes unless this code is used.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p dir="rtl" style="font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; color: #444; text-align: center; line-height: 32px;">
    کسی نے یہ ای میل ایڈریس <span style="direction: ltr; unicode-bidi: embed;">${tenantName}</span> پورٹل اکاؤنٹ کے لاگ ان ای میل کے طور پر مقرر کرنے کی درخواست کی ہے۔ اسے تصدیق کرنے کے لیے یہ کوڈ پروفائل صفحے پر درج کریں۔ اس کی میعاد 15 منٹ میں ختم ہو جائے گی۔ اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کریں۔
  </p>
</div>`.trim()
}

// Best-effort notice to the OLD address once a change is confirmed — same
// "like a professional site would do" reasoning as passwordChangedEmail,
// sent to whichever email is about to stop being valid for this account.
export function portalEmailChangedNoticeEmail(newEmail: string, tenantName: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #0d3b2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">DP</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${tenantName}</h1>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Your portal email was changed</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Your ${tenantName} portal account's email was just changed to <strong style="direction: ltr; unicode-bidi: embed;">${newEmail}</strong>.
    This address will no longer receive account emails.
  </p>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't make this change, contact the committee right away.
  </p>
</div>`.trim()
}
