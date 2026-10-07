import crypto from 'crypto'

// EasyPaisa Open API (REST, HMAC-signed redirect) integration.
//
// ** Needs real credentials before this can process a live payment,
// same as jazzcash.ts — EASYPAISA_STORE_ID/HASH_KEY only exist once the
// user sets up a real EasyPaisa merchant account. ** EasyPaisa has
// historically offered more than one integration product (an older
// encrypted-request "Easypay" redirect flow, and a newer HMAC-signed
// "Open API"); this targets the HMAC-signed shape specifically, the same
// structural pattern as jazzcash.ts (sorted fields, HMAC-SHA256, hash
// key), since that's the one that can be built and reasoned about
// correctly without a live doc fetch. The exact field list/endpoint is
// the one thing that would need a final check against EasyPaisa's
// current merchant docs once real credentials exist.

export interface EasyPaisaConfig {
  storeId: string
  hashKey: string
  mode: 'sandbox' | 'live'
}

export function getEasyPaisaConfig(): EasyPaisaConfig | null {
  const storeId = process.env.EASYPAISA_STORE_ID
  const hashKey = process.env.EASYPAISA_HASH_KEY
  if (!storeId || !hashKey) return null
  const mode = process.env.EASYPAISA_MODE === 'live' ? 'live' : 'sandbox'
  return { storeId, hashKey, mode }
}

export function easyPaisaCheckoutUrl(mode: 'sandbox' | 'live'): string {
  return mode === 'live'
    ? 'https://easypay.easypaisa.com.pk/easypay/Index.jsf'
    : 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf'
}

// Same sorted-fields HMAC-SHA256 pattern as JazzCash's computeSecureHash
// (see that file's own comment) — sort by field name, join values with
// '&', HMAC keyed by the hash key, uppercase hex.
export function computeHashedReq(fields: Record<string, string>, hashKey: string): string {
  const sortedKeys = Object.keys(fields).filter((k) => k !== 'merchantHashedReq' && fields[k] !== '' && fields[k] != null).sort()
  const joined = sortedKeys.map((k) => fields[k]).join('&')
  const hmac = crypto.createHmac('sha256', hashKey)
  hmac.update(`${hashKey}&${joined}`)
  return hmac.digest('hex').toUpperCase()
}

export interface CheckoutRequest {
  amountPkr: number
  txnRefNo: string
  description: string
  returnUrl: string
}

export function buildCheckoutFields(config: EasyPaisaConfig, req: CheckoutRequest): Record<string, string> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const txnDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const expiry = new Date(now.getTime() + 60 * 60_000)
  const txnExpiryDateTime = `${expiry.getFullYear()}${pad(expiry.getMonth() + 1)}${pad(expiry.getDate())}${pad(expiry.getHours())}${pad(expiry.getMinutes())}${pad(expiry.getSeconds())}`

  const fields: Record<string, string> = {
    storeId: config.storeId,
    amount: req.amountPkr.toFixed(2),
    orderRefNum: req.txnRefNo,
    transactionDateTime: txnDateTime,
    transactionExpiryDateTime: txnExpiryDateTime,
    postBackURL: req.returnUrl,
    autoRedirect: '1',
    paymentMethod: 'InitialOptions',
  }
  fields.merchantHashedReq = computeHashedReq(fields, config.hashKey)
  return fields
}

export function verifyReturnedFields(fields: Record<string, string>, hashKey: string): boolean {
  const theirHash = fields.merchantHashedReq
  if (!theirHash) return false
  const recomputed = computeHashedReq(fields, hashKey)
  return recomputed === theirHash.toUpperCase()
}
