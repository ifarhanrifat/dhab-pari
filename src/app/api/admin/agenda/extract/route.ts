import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'

// Extracts discrete Urdu agenda points from photographed handwritten meeting
// notes. Deliberately "correction only" per the user's explicit design: the
// model drafts text, a human reviews/edits/assigns every point before
// anything is saved — this route never writes to the database itself.
//
// Uses Gemini (Google AI Studio) rather than a paid API — its free tier
// needs no billing/credit card, unlike the Anthropic API this was originally
// built against, and Gemini's vision models read Urdu/Nastaliq reasonably.
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number]

const SYSTEM_PROMPT = `You are extracting a handwritten Urdu committee meeting agenda from photographs for a village water & welfare committee.

Identify each distinct discussion point or task written in the agenda as a separate item. Fix only obvious handwriting/OCR misreadings — never add, summarize, merge, or invent content that isn't in the photo. Preserve the original Urdu wording as closely as possible.

Respond with ONLY a JSON array of strings, one per agenda point, in the order they appear in the photo(s). No other text, no markdown code fences, no explanation. Example: ["پہلا نکتہ", "دوسرا نکتہ"]`

function extractJsonArray(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/)
  const raw = match ? match[0] : text
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Model response was not a JSON array')
  return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
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

  const { data: caller } = await supabase.from('admin_users').select('role, secondary_role').eq('auth_user_id', user.id).single()
  const isAdminTier = caller?.role === 'super_admin' || caller?.role === 'admin' || caller?.secondary_role === 'super_admin' || caller?.secondary_role === 'admin'
  if (!isAdminTier) {
    return NextResponse.json({ error: 'Only an admin can run AI extraction.' }, { status: 403 })
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: 'AI extraction is not configured yet — GEMINI_API_KEY is missing from the server environment. Get a free key at aistudio.google.com/apikey, add it, and restart the app.' }, { status: 500 })
  }

  let body: { photoUrls?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const photoUrls = (body.photoUrls ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0)
  if (photoUrls.length === 0) {
    return NextResponse.json({ error: 'No agenda photos to extract from.' }, { status: 400 })
  }

  let imageParts: { inlineData: { mimeType: AllowedMediaType; data: string } }[]
  try {
    imageParts = await Promise.all(photoUrls.map(async (url) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Could not fetch photo: ${url}`)
      const contentType = res.headers.get('content-type') ?? ''
      const mediaType = ALLOWED_MEDIA_TYPES.find((t) => contentType.includes(t.split('/')[1]))
      if (!mediaType) throw new Error(`Unsupported image type for ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      return { inlineData: { mimeType: mediaType, data: buf.toString('base64') } }
    }))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load agenda photos.' }, { status: 400 })
  }

  try {
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    const result = await genAI.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [{ role: 'user', parts: [...imageParts, { text: 'Extract the agenda points from these photo(s).' }] }],
      config: { systemInstruction: SYSTEM_PROMPT },
    })
    const text = result.text ?? result.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('No text in model response')
    const points = extractJsonArray(text)
    return NextResponse.json({ points })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI extraction failed.' }, { status: 500 })
  }
}
