import crypto from 'crypto'

// JazzCash Hosted Checkout Page integration.
//
// ** Needs real credentials before this can process a live payment. **
// JazzCash issues these per-merchant — there is no way to obtain or test
// them without a real JazzCash merchant account, which only the user can
// set up. Until JAZZCASH_MERCHANT_ID/PASSWORD/INTEGRITY_SALT are set,
// checkout initiation below fails cleanly with a clear error rather than
// silently sending a malformed, unsigned request.
//
// The field list and hashing scheme here follow JazzCash's publicly
// documented Hosted Checkout Page API (pp_* fields, HMAC-SHA256 secure
// hash over sorted field values, keyed by the Integrity Salt). This is
// the one place the exact field names/endpoint would need adjusting
// against JazzCash's current sandbox docs once real credentials exist —
// everything else in the checkout/webhook flow is provider-agnostic.

export interface JazzCashConfig {
  merchantId: string
  password: string
  integritySalt: string
  mode: 'sandbox' | 'live'
}

export function getJazzCashConfig(): JazzCashConfig | null {
  const merchantId = process.env.JAZZCASH_MERCHANT_ID
  const password = process.env.JAZZCASH_PASSWORD
  const integritySalt = process.env.JAZZCASH_INTEGRITY_SALT
  if (!merchantId || !password || !integritySalt) return null
  const mode = process.env.JAZZCASH_MODE === 'live' ? 'live' : 'sandbox'
  return { merchantId, password, integritySalt, mode }
}

export function jazzCashCheckoutUrl(mode: 'sandbox' | 'live'): string {
  return mode === 'live'
    ? 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/'
    : 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/'
}

// Sorts by field name, joins VALUES with '&', prepends the integrity
// salt, HMAC-SHA256s the result keyed by the same salt, uppercases the
// hex digest. Used both to sign an outgoing checkout request and to
// verify JazzCash's own returned fields.
export function computeSecureHash(fields: Record<string, string>, integritySalt: string): string {
  const sortedKeys = Object.keys(fields).filter((k) => k !== 'pp_SecureHash' && fields[k] !== '' && fields[k] != null).sort()
  const joined = sortedKeys.map((k) => fields[k]).join('&')
  const hmac = crypto.createHmac('sha256', integritySalt)
  hmac.update(`${integritySalt}&${joined}`)
  return hmac.digest('hex').toUpperCase()
}

export interface CheckoutRequest {
  amountPkr: number
  txnRefNo: string
  description: string
  returnUrl: string
}

// Builds the full signed field set for an auto-submitting checkout
// redirect. pp_Amount is in paisas (PKR * 100) per JazzCash convention.
export function buildCheckoutFields(config: JazzCashConfig, req: CheckoutRequest): Record<string, string> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const txnDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const expiry = new Date(now.getTime() + 60 * 60_000) // 1 hour to complete payment
  const txnExpiryDateTime = `${expiry.getFullYear()}${pad(expiry.getMonth() + 1)}${pad(expiry.getDate())}${pad(expiry.getHours())}${pad(expiry.getMinutes())}${pad(expiry.getSeconds())}`

  const fields: Record<string, string> = {
    pp_Version: '1.1',
    pp_TxnType: 'MWALLET',
    pp_Language: 'EN',
    pp_MerchantID: config.merchantId,
    pp_Password: config.password,
    pp_TxnRefNo: req.txnRefNo,
    pp_Amount: String(Math.round(req.amountPkr * 100)),
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: txnDateTime,
    pp_TxnExpiryDateTime: txnExpiryDateTime,
    pp_BillReference: req.txnRefNo,
    pp_Description: req.description,
    pp_ReturnURL: req.returnUrl,
  }
  fields.pp_SecureHash = computeSecureHash(fields, config.integritySalt)
  return fields
}

// Verifies a returned/callback field set against its own pp_SecureHash —
// rejects anything tampered with in transit (e.g. a replayed or
// hand-edited browser redirect), since recomputing the hash requires the
// server-side-only integrity salt.
export function verifyReturnedFields(fields: Record<string, string>, integritySalt: string): boolean {
  const theirHash = fields.pp_SecureHash
  if (!theirHash) return false
  const recomputed = computeSecureHash(fields, integritySalt)
  return recomputed === theirHash.toUpperCase()
}
