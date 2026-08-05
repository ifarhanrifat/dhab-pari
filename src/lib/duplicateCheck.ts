// Shared duplicate guard for anywhere a new consumer/connection identity gets
// entered (Billing "Add Consumer", New Connection Request) — checked against
// both real consumers and not-yet-converted connection_requests, since a
// duplicate can originate from either side of that pipeline.
//
// Mobile/WhatsApp match hard-blocks on their own (a phone number genuinely
// shouldn't belong to two different accounts). Name alone does NOT block —
// common names repeat in a real village — but name + father's name matching
// together is a strong enough signal of an accidental re-entry to block too.

export interface DuplicateCandidate {
  id: string
  name: string | null
  father_husband_name: string | null
  mobile: string | null
  whatsapp_number: string | null
}

export interface DuplicateCheckInput {
  name: string
  father_husband_name?: string | null
  mobile?: string | null
  whatsapp_number?: string | null
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export function findDuplicate(input: DuplicateCheckInput, candidates: DuplicateCandidate[], excludeId?: string): string | null {
  const name = norm(input.name)
  const father = norm(input.father_husband_name)
  const mobile = norm(input.mobile)
  const whatsapp = norm(input.whatsapp_number)

  for (const c of candidates) {
    if (excludeId && c.id === excludeId) continue
    if (mobile && norm(c.mobile) === mobile) {
      return `Mobile number ${input.mobile} is already registered to ${c.name || 'another consumer'}.`
    }
    if (whatsapp && norm(c.whatsapp_number) === whatsapp) {
      return `WhatsApp number ${input.whatsapp_number} is already registered to ${c.name || 'another consumer'}.`
    }
    if (name && father && norm(c.name) === name && norm(c.father_husband_name) === father) {
      return `A consumer named "${input.name}" son/daughter of "${input.father_husband_name}" already exists${c.mobile ? ` (${c.mobile})` : ''}. If this is genuinely a different person, adjust the name slightly or contact support.`
    }
  }
  return null
}
