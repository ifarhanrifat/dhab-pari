import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'
import { createAdminClient } from '@/lib/supabase/admin'

// Point-of-sale recognition: the same camera step as scan-product, but
// this time matching a photo against the shop's OWN already-catalogued
// products rather than drafting a new one. The model never invents a
// product — it's given a numbered list of exactly what this shop already
// stocks and must either pick one number or say no match, which the
// keeper then confirms before it's added to the bill (this touches stock
// and money, so nothing here auto-adds without a human tap).
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number]

function extractJsonObject(text: string): { match: number | null } {
  const match = text.match(/\{[\s\S]*\}/)
  const raw = match ? match[0] : text
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Model response was not a JSON object')
  return parsed
}

// See scan-product/route.ts's identical helper — same SDK, same raw-JSON
// error shape to translate.
function friendlyGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : ''
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) {
    return 'Your Gemini API key was rejected — check it in Shop Settings and make sure you copied it in full.'
  }
  return 'Could not read that photo — try again, or search for the item by name.'
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

  const { data: shop } = await supabase.from('shops').select('id').eq('id', shopId).eq('portal_user_id', portalUser.id).maybeSingle()
  if (!shop) return NextResponse.json({ error: 'You do not manage this shop.' }, { status: 403 })

  const admin = createAdminClient()
  const [{ data: aiSettings }, { data: products }] = await Promise.all([
    admin.from('shop_ai_settings').select('gemini_api_key').eq('shop_id', shopId).maybeSingle(),
    admin.from('shop_products').select('id, name, name_ur, company, flavor').eq('shop_id', shopId).eq('is_active', true).order('name'),
  ])
  const apiKey = aiSettings?.gemini_api_key
  if (!apiKey) {
    return NextResponse.json({ error: 'Add your free Gemini API key in Shop Settings first.' }, { status: 400 })
  }
  if (!products || products.length === 0) {
    return NextResponse.json({ error: 'No products in your catalog yet to match against.' }, { status: 400 })
  }

  const listing = products.map((p, i) => `${i + 1}. ${p.name}${p.flavor ? ' - ' + p.flavor : ''}${p.name_ur ? ' / ' + p.name_ur : ''}${p.company ? ' (' + p.company + ')' : ''}`).join('\n')
  const systemPrompt = `You are helping a Pakistani corner-store keeper ring up a sale by recognising a product from a photo, matching it ONLY against products this shop already stocks:

${listing}

Look at the photo and decide which numbered product (if any) it is. Several entries may be the same product in different flavors/variants (e.g. "Chips - Salted" vs "Chips - BBQ") — read the flavor off the packaging carefully and pick the exact matching variant, not just the closest name. Only pick a number if you are reasonably confident — this affects a real bill. If it doesn't clearly match any item on the list, or you're unsure which flavor it is, say no match.

Respond with ONLY a JSON object, no markdown fences, no other text: {"match": <number from the list, or null if no confident match>}`

  try {
    const genAI = new GoogleGenAI({ apiKey })
    const result = await genAI.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: 'Which product is this?' }] }],
      config: { systemInstruction: systemPrompt },
    })
    const text = result.text ?? result.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('No text in model response')
    const { match } = extractJsonObject(text)
    const idx = typeof match === 'number' ? match - 1 : -1
    const product = idx >= 0 && idx < products.length ? products[idx] : null
    if (!product) return NextResponse.json({ product: null })
    return NextResponse.json({ product: { id: product.id, name: product.name, name_ur: product.name_ur, company: product.company, flavor: product.flavor } })
  } catch (err) {
    return NextResponse.json({ error: friendlyGeminiError(err) }, { status: 500 })
  }
}
