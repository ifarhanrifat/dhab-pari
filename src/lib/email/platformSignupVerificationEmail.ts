// Same code-not-link pattern as portalSignupVerificationEmail.ts (see
// that file's own comment) — this one verifies the EMAIL of a brand new
// committee's first admin, before any tenant/account exists at all, so
// there's no tenant name to show yet (unlike the portal version).
export function platformSignupVerificationEmail(code: string, committeeName: string) {
  return `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <div style="display: inline-block; width: 48px; height: 48px; border-radius: 50%; background: #1a1f2e; color: white; line-height: 48px; font-weight: bold; font-size: 20px;">+</div>
    <h1 style="font-size: 18px; margin: 12px 0 0;">${committeeName}</h1>
    <p style="font-size: 13px; color: #666; margin: 2px 0 0;">New committee signup</p>
  </div>
  <h2 style="font-size: 20px; text-align: center; margin-bottom: 8px;">Verify your email</h2>
  <p style="font-size: 14px; color: #444; text-align: center; line-height: 22px;">
    Enter this code to finish setting up ${committeeName}'s account. It expires in 15 minutes.
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; background: #f0faf6; border: 2px solid #1D9E75; color: #0d3b2e; letter-spacing: 8px; font-size: 32px; font-weight: 700; padding: 16px 24px; border-radius: 10px; font-family: monospace;">${code}</span>
  </div>
  <p style="font-size: 12.5px; color: #888; text-align: center; line-height: 20px;">
    If you didn't request this, you can safely ignore this email — nothing is created unless this code is used.
  </p>
</div>`.trim()
}
