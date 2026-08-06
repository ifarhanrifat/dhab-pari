import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { GoogleGenAI } from '@google/genai'

// Rough, non-binding cost estimate for a village project proposal — reuses
// the same Gemini setup already configured for agenda photo extraction
// (GEMINI_API_KEY, gemini-flash-latest). This is explicitly NOT a real
// quote: prices in Pakistan shift with inflation/region and the model has
// no live price feed — the committee still fixes the real funded budget at
// approval. Two stages only: "modern equipment" then "cheapest way", each
// possibly asking a clarifying question first; the model is told to end
// with a machine-parseable "FINAL_ESTIMATE: <number>" line once it has
// enough information, which the client watches for to know when to stop
// the back-and-forth and show a number.
const SYSTEM_PROMPT = (stage: 'modern' | 'cheapest') => `You are estimating a rough construction/welfare project cost in Pakistani Rupees (PKR) for a small village committee (Dhab Pari) in Pakistan.

Stage: ${stage === 'modern' ? 'Estimate using modern, good-quality equipment and materials (not the cheapest, not luxury — solid, standard modern quality).' : 'Estimate using the CHEAPEST realistic way to accomplish the same project — cheaper materials/labor/approach, while still being safe and functional.'}

If you genuinely need more detail to give a reasonable estimate (e.g. number of households, length/area, material grade), ask ONE short, specific clarifying question and nothing else — no estimate yet.

Once you have enough information, respond with:
1. A short (2-4 sentence) breakdown of what's driving the cost.
2. A final line, exactly in this format with no other text after it: FINAL_ESTIMATE: <number>
   (just the number, no "Rs." or commas, e.g. FINAL_ESTIMATE: 185000)

Keep all responses brief and in plain English. Never claim this is an exact quote — it's a rough estimate for community reference only.`

interface ChatTurn { role: 'user' | 'model'; text: string }

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

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: 'AI estimation is not configured yet — GEMINI_API_KEY is missing from the server environment.' }, { status: 500 })
  }

  let body: { title?: string; description?: string; category?: string; stage?: 'modern' | 'cheapest'; history?: ChatTurn[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const stage = body.stage === 'cheapest' ? 'cheapest' : 'modern'
  const history = Array.isArray(body.history) ? body.history : []

  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = []
  if (history.length === 0) {
    const intro = `Project title: ${body.title ?? ''}\nCategory: ${body.category ?? ''}\nDescription: ${body.description ?? ''}\n\nGive your estimate for this project.`
    contents.push({ role: 'user', parts: [{ text: intro }] })
  } else {
    for (const turn of history) contents.push({ role: turn.role, parts: [{ text: turn.text }] })
  }

  try {
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    const result = await genAI.models.generateContent({
      model: 'gemini-flash-latest',
      contents,
      config: { systemInstruction: SYSTEM_PROMPT(stage) },
    })
    const text = result.text ?? result.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('No text in model response')

    const match = text.match(/FINAL_ESTIMATE:\s*([\d,]+)/)
    const finalEstimate = match ? Number(match[1].replace(/,/g, '')) : null

    return NextResponse.json({ text, finalEstimate })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI estimation failed.' }, { status: 500 })
  }
}
