import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'
import { createAdminClient } from '@/lib/supabase/admin'
import { getShopTypeTree } from '@/lib/shopTypes'

// Camera-to-catalog: a shop keeper photographs a physical product, Gemini
// reads the packaging and drafts name/company/category/description — the
// keeper still reviews everything, sets the category if the guess is
// wrong, and always sets the buying/selling price by hand (the model has
// no way to know those). Same shape as agenda/extract's photo route, but
// keyed off the SHOP'S OWN Gemini key (shop_ai_settings), not the site's
// shared GEMINI_API_KEY — each shop pays for its own usage, free-tier or
// not, and the key never leaves the server (fetched here via the admin
// client only after confirming the caller actually owns this shop).
//
// The category list passed to the model is THIS SHOP'S OWN tree (its
// shop type), not the full ~170-slug list across every shop type —
// keeps the model's choice constrained to what's actually plausible for
// this business and improves match accuracy on a shorter, more relevant
// list (a butcher's photo should never be offered "Tandoori Roti").
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number]

function buildSystemPrompt(categorySlugs: string[], categoryListing: string): string {
  return `You are helping a small Pakistani shop keeper add a product to their shop's catalog from a photo of the item (its packaging/label, or the item itself for unpackaged goods/services).

Read whatever is printed on the packaging (brand, product name, variant/size, language may be English or Urdu) and draft catalog fields for it. Never invent details that aren't legible in the photo — leave a field empty rather than guess.

Pick the single best-fitting category from EXACTLY this list (code — English label / Urdu label):
${categoryListing}

Respond with the category CODE only (e.g. "${categorySlugs[0]}"), not the label. Use "other" if none fit and it's in the list, otherwise pick the closest one.

Most packaged products (biscuits, chips, drinks, etc.) come in a specific flavor or variant — read it off the packaging if printed (e.g. "Salted", "BBQ", "Chocolate", "Orange", "Masala"). Leave it empty if the product has no flavor/variant (e.g. plain rice, a bar of soap) or none is legible.

Also rate your own confidence in this reading as a number from 0 to 1 — 1 means every field was clearly legible on the packaging, lower means you had to guess or the photo was blurry/partial/glare. Be honest and conservative; a shopkeeper will be asked to double-check anything below 0.75.

Respond with ONLY a JSON object, no markdown fences, no other text, in this exact shape:
{"name": "product name in English/Roman, as printed", "name_ur": "product name in Urdu script if determinable, else empty string", "company": "brand/manufacturer name, else empty string", "category": "one of the allowed category codes", "flavor": "flavor/variant in English/Roman if printed, else empty string", "flavor_ur": "flavor/variant in Urdu script if determinable, else empty string", "description": "one short phrase, e.g. size/variant, else empty string", "confidence": 0.0}`
}

function extractJsonObject(text: string): Record<string, string | number> {
  const match = text.match(/\{[\s\S]*\}/)
  const raw = match ? match[0] : text
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Model response was not a JSON object')
  return parsed
}

// Gemini's own SDK throws with its raw API error JSON as the message
// (e.g. {"error":{"code":400,"message":"API key not valid...`) — not
// something to show a shopkeeper. Translate the one case they can
// actually fix themselves; anything else falls back to a plain message.
function friendlyGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : ''
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) {
    return 'Your Gemini API key was rejected — check it in Shop Settings and make sure you copied it in full.'
  }
  return 'Could not read that photo — try again with better lighting, or enter the product by hand.'
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: portalUser } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
  if (!portalUser) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { shopId?: string; imageBase64?: string; mimeType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { shopId, imageBase64, mimeType } = body
  if (!shopId || !imageBase64 || !mimeType) {
    return NextResponse.json({ error: 'Missing photo or shop.' }, { status: 400 })
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mimeType as AllowedMediaType)) {
    return NextResponse.json({ error: 'Unsupported image type — use JPEG, PNG or WEBP.' }, { status: 400 })
  }

  // Ownership check happens against the caller's own session (RLS-backed,
  // not the admin client) so this can't be used to probe another shop.
  const { data: shop } = await supabase.from('shops').select('id, primary_type').eq('id', shopId).eq('portal_user_id', portalUser.id).maybeSingle()
  if (!shop) return NextResponse.json({ error: 'You do not manage this shop.' }, { status: 403 })

  const tree = getShopTypeTree(shop.primary_type)
  const categorySlugs = tree.flatMap((d) => d.categories.map((c) => c.slug))
  // Urdu label included per category — packaging text is often Urdu, and
  // the model matches it more reliably against an Urdu label than an
  // English one alone.
  const categoryListing = tree.flatMap((d) => d.categories.map((c) => `${c.slug} — ${c.label} / ${c.label_ur}`)).join('\n')

  const admin = createAdminClient()
  const { data: aiSettings } = await admin.from('shop_ai_settings').select('gemini_api_key').eq('shop_id', shopId).maybeSingle()
  const apiKey = aiSettings?.gemini_api_key
  if (!apiKey) {
    return NextResponse.json({ error: 'Add your free Gemini API key in Shop Settings first — get one at aistudio.google.com/apikey.' }, { status: 400 })
  }

  try {
    const genAI = new GoogleGenAI({ apiKey })
    const result = await genAI.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: 'Draft catalog fields for this product.' }] }],
      config: { systemInstruction: buildSystemPrompt(categorySlugs, categoryListing) },
    })
    const text = result.text ?? result.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('No text in model response')
    const fields = extractJsonObject(text)
    const category = categorySlugs.includes(String(fields.category)) ? String(fields.category) : 'other'
    // Missing/unparseable confidence reads as 0, not 1 — an old model
    // response shape or a field the model dropped should trigger the
    // "please confirm" path, never silently skip it.
    const confidence = Number(fields.confidence)
    return NextResponse.json({
      name: fields.name ?? '', name_ur: fields.name_ur ?? '', company: fields.company ?? '',
      category, flavor: fields.flavor ?? '', flavor_ur: fields.flavor_ur ?? '', description: fields.description ?? '',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    })
  } catch (err) {
    return NextResponse.json({ error: friendlyGeminiError(err) }, { status: 500 })
  }
}
