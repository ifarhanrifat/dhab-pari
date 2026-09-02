// Turns a raw Supabase/Postgres error into something a committee member can
// actually act on.
//
// Before this, 144 call sites passed the raw `error.message` straight to
// toast.error(), so a viewer who clicked Edit saw:
//   new row violates row-level security policy for table "consumers"
// which tells them nothing and looks like the app broke. The app's own
// RAISE EXCEPTION messages ("Only an admin can cancel a meeting.") are
// already written for humans, so those pass through untouched — this only
// rewrites the machine-generated ones.
//
// Urdu: an optional third argument. A driver on the adda/vehicle-marketplace
// pages sees these RAISE EXCEPTION messages constantly (check-in geofence,
// operating hours, seat limits...) and the app is otherwise fully bilingual
// there — an English-only alert in the middle of an Urdu screen reads as
// broken. ADDA_TRANSLATIONS below is a curated table for that specific
// cluster of messages (adda_check_in/mark_departed/pass_turn/claim_front/
// leave_queue, book_adda_seat, adda_update_seats, the trip-offer/live-share
// RPCs, propose/respond_trip_fare) — not a general SQL-message-to-Urdu
// pipeline. A message outside this table still falls back to its English
// text rather than showing nothing, exactly as before this change.

interface PgLikeError {
  message?: string
  code?: string
  details?: string | null
  hint?: string | null
}

const PERMISSION_MESSAGE = "You don't have permission to do this. Ask an admin if you need access."
const PERMISSION_MESSAGE_UR = 'آپ کو یہ کرنے کی اجازت نہیں ہے۔ رسائی کے لیے ایڈمن سے رابطہ کریں۔'

export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.', isUrdu = false): string {
  if (!error) return isUrdu ? 'کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔' : fallback

  const e = (typeof error === 'object' ? error : {}) as PgLikeError
  const raw = (e.message ?? (typeof error === 'string' ? error : '')).trim()
  const code = e.code ?? ''
  const lower = raw.toLowerCase()

  // Permission / RLS — by far the most common confusing one.
  if (
    code === '42501' ||
    lower.includes('row-level security') ||
    lower.includes('row level security') ||
    lower.includes('permission denied') ||
    lower.includes('insufficient_privilege')
  ) return isUrdu ? PERMISSION_MESSAGE_UR : PERMISSION_MESSAGE

  // Not authenticated / session expired.
  if (code === 'PGRST301' || lower.includes('jwt expired') || lower.includes('invalid token')) {
    return isUrdu ? 'آپ کا سیشن ختم ہو گیا ہے۔ دوبارہ لاگ ان کریں۔' : 'Your session has expired. Please log in again.'
  }

  // Constraint violations, in plain language.
  if (code === '23505' || lower.includes('duplicate key')) {
    return isUrdu ? 'یہ پہلے سے موجود ہے — یہ ایک ڈپلیکیٹ لگتا ہے۔' : 'This already exists — it looks like a duplicate.'
  }
  if (code === '23503' || lower.includes('violates foreign key')) {
    return isUrdu
      ? 'اسے حذف نہیں کیا جا سکتا کیونکہ دوسرے ریکارڈ اب بھی اس سے جڑے ہیں۔ پہلے انہیں حذف یا تبدیل کریں۔'
      : "This can't be removed because other records still refer to it. Delete or reassign those first."
  }
  if (code === '23502' || lower.includes('null value in column')) {
    return isUrdu ? 'ایک ضروری خانہ خالی ہے۔' : 'A required field is missing.'
  }
  if (code === '23514' || lower.includes('violates check constraint')) {
    return isUrdu ? 'یہ قدر یہاں درست نہیں ہے۔ فارم چیک کر کے دوبارہ کوشش کریں۔' : "That value isn't allowed here. Please check the form and try again."
  }

  // Network / offline.
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
    return isUrdu ? 'سرور تک نہیں پہنچ سکے۔ اپنا انٹرنیٹ کنکشن چیک کر کے دوبارہ کوشش کریں۔' : 'Could not reach the server. Check your internet connection and try again.'
  }

  // Our own RAISE EXCEPTION text from the SQL functions is already
  // human-readable and specific — show it as-is rather than burying it.
  // Postgres prefixes nothing to these, and they read like sentences.
  if (raw && !looksMachineGenerated(raw)) {
    if (isUrdu) {
      const translated = translateAddaMessage(raw)
      if (translated) return translated
    }
    return raw
  }

  return isUrdu ? 'کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔' : fallback
}

// Heuristic: internal Postgres errors mention SQL machinery (relations,
// columns, types, functions). A message written by us in a RAISE EXCEPTION
// doesn't.
function looksMachineGenerated(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('relation "') ||
    lower.includes('column "') ||
    lower.includes('function ') ||
    lower.includes('syntax error') ||
    lower.includes('does not exist') ||
    lower.includes('sqlstate') ||
    lower.includes('constraint')
  )
}

// True when the failure was specifically an authorization problem — lets a
// caller show a different UI (e.g. hide the button) rather than just toast.
export function isPermissionError(error: unknown): boolean {
  return friendlyError(error) === PERMISSION_MESSAGE
}

// ─── Adda / vehicle-marketplace RAISE EXCEPTION → Urdu ─────────────────
// Exact-text messages first (fast map lookup), then a handful with a
// Postgres-interpolated number/time baked into the final string (regex,
// captured and re-inserted — digits and times stay as-is, same convention
// the rest of this app's Urdu strings already use for {amount}-style values).
const ADDA_EXACT: Record<string, string> = {
  'This adda is not available.': 'یہ اڈا دستیاب نہیں ہے۔',
  'This vehicle is not available.': 'یہ گاڑی دستیاب نہیں ہے۔',
  'You do not manage this vehicle.': 'آپ اس گاڑی کے منتظم نہیں ہیں۔',
  "This vehicle's wallet balance is too low to join the queue — top up first.": 'اس گاڑی کے والٹ میں قطار میں شامل ہونے کے لیے کافی رقم نہیں ہے — پہلے بیلنس بھریں۔',
  'Top up your wallet before checking in — an adda slot needs a positive balance.': 'چیک ان سے پہلے اپنا والٹ بھریں — اڈے کی جگہ کے لیے مثبت بیلنس ضروری ہے۔',
  "Turn on your location to check in — we need to confirm you're at the adda.": 'چیک ان کے لیے اپنی لوکیشن آن کریں — ہمیں تصدیق کرنی ہے کہ آپ اڈے پر موجود ہیں۔',
  'This vehicle is already in a queue today.': 'یہ گاڑی آج پہلے ہی قطار میں شامل ہے۔',
  'Invalid fare mode.': 'کرایہ موڈ درست نہیں ہے۔',
  'This adda has no fare set yet — ask the committee to set one first.': 'اس اڈے کا کرایہ ابھی مقرر نہیں ہوا — پہلے کمیٹی سے کرایہ مقرر کروائیں۔',
  'Queue entry not found.': 'قطار کی انٹری نہیں ملی۔',
  'This vehicle is not currently at the front of the queue.': 'یہ گاڑی فی الحال قطار کے آگے نہیں ہے۔',
  'This vehicle is not waiting in this queue.': 'یہ گاڑی اس قطار میں انتظار نہیں کر رہی۔',
  'A vehicle ahead of you in line can claim the front first.': 'آپ سے آگے کی گاڑی پہلے آگے کی باری لے سکتی ہے۔',
  'Only a waiting vehicle can leave the queue this way.': 'صرف انتظار کرنے والی گاڑی اس طرح قطار چھوڑ سکتی ہے۔',
  'This vehicle is no longer waiting at the adda.': 'یہ گاڑی اب اڈے پر انتظار نہیں کر رہی۔',
  'Trip offer not found.': 'سفر کی پیشکش نہیں ملی۔',
  'You do not manage this trip.': 'آپ اس سفر کے منتظم نہیں ہیں۔',
  'Live sharing is not active for this trip.': 'اس سفر کے لیے لائیو لوکیشن شیئرنگ فعال نہیں ہے۔',
  'Sign in first.': 'پہلے سائن ان کریں۔',
  'This vehicle is no longer taking bookings.': 'یہ گاڑی اب بکنگ قبول نہیں کر رہی۔',
  'This vehicle takes ride requests, not fixed-fare bookings — propose a fare instead.': 'یہ گاڑی رائیڈ ریکویسٹ لیتی ہے، مقررہ کرایہ بکنگ نہیں — اس کے بجائے کرایہ تجویز کریں۔',
  'Pick at least one seat.': 'کم از کم ایک نشست منتخب کریں۔',
  'Upload your payment slip.': 'اپنی ادائیگی کی رسید اپ لوڈ کریں۔',
  'This vehicle is temporarily unable to take new bookings.': 'یہ گاڑی فی الحال نئی بکنگ قبول نہیں کر سکتی۔',
  "This vehicle's wallet balance is too low to cover this booking's commission — the driver needs to top up first.": 'اس گاڑی کے والٹ میں اس بکنگ کا کمیشن پورا کرنے کے لیے کافی رقم نہیں — ڈرائیور کو پہلے بیلنس بھرنا ہوگا۔',
  'Enter the fixed fare per seat.': 'فی نشست مقررہ کرایہ درج کریں۔',
  'A ride-request vehicle should not set a fixed fare.': 'رائیڈ ریکویسٹ گاڑی کے لیے مقررہ کرایہ درج نہ کریں۔',
  'Booking not found': 'بکنگ نہیں ملی۔',
  'This booking is not awaiting confirmation.': 'یہ بکنگ تصدیق کی منتظر نہیں ہے۔',
  'Not authorized': 'اجازت نہیں ہے۔',
  'Pick a date in the future.': 'آئندہ کی کوئی تاریخ منتخب کریں۔',
  'Enter how many seats are free.': 'بتائیں کتنی نشستیں خالی ہیں۔',
  'This trip is no longer available.': 'یہ سفر اب دستیاب نہیں ہے۔',
  'Enter a fare to offer.': 'پیش کرنے کے لیے کرایہ درج کریں۔',
  'This offer is no longer pending.': 'یہ پیشکش اب زیر التوا نہیں ہے۔',
  'This trip no longer has enough free seats.': 'اس سفر میں مزید خالی نشستیں نہیں ہیں۔',
  'Enter a counter-offer amount.': 'جوابی پیشکش کی رقم درج کریں۔',
  'Invalid action.': 'یہ عمل درست نہیں ہے۔',
  'This counter-offer is no longer available.': 'یہ جوابی پیشکش اب دستیاب نہیں ہے۔',
  'Nothing to withdraw.': 'واپس لینے کے لیے کچھ نہیں ہے۔',
  'This trip is not awaiting completion.': 'یہ سفر تکمیل کا منتظر نہیں ہے۔',
  'This trip is not active.': 'یہ سفر فعال نہیں ہے۔',
  'You are not part of this trip.': 'آپ اس سفر کا حصہ نہیں ہیں۔',
}

const ADDA_PATTERNS: Array<{ re: RegExp; ur: (m: RegExpMatchArray) => string }> = [
  { re: /^You need to be at the adda to check in — you appear to be ([\d.]+) km away\.$/, ur: (m) => `چیک ان کے لیے آپ کا اڈے پر ہونا ضروری ہے — آپ تقریباً ${m[1]} کلومیٹر دور معلوم ہوتے ہیں۔` },
  { re: /^Enter how many seats are actually free \(1 to (\d+)\)\.$/, ur: (m) => `بتائیں کتنی نشستیں واقعی خالی ہیں (1 سے ${m[1]} تک)۔` },
  { re: /^This adda only runs (.+?) to (.+?) — check in during those hours, or ask the committee about night service\.$/, ur: (m) => `یہ اڈا صرف ${m[1]} سے ${m[2]} تک چلتا ہے — انہی اوقات میں چیک ان کریں، یا رات کی سروس کے بارے میں کمیٹی سے پوچھیں۔` },
  { re: /^The current vehicle still has (\d+) minute\(s\) left on its turn\.$/, ur: (m) => `موجودہ گاڑی کی باری میں ابھی ${m[1]} منٹ باقی ہیں۔` },
  { re: /^Only (\d+) seat\(s\) left on this vehicle\.$/, ur: (m) => `اس گاڑی میں صرف ${m[1]} نشست(یں) باقی ہیں۔` },
  { re: /^Only (\d+) seat\(s\) available on this trip\.$/, ur: (m) => `اس سفر میں صرف ${m[1]} نشست(یں) دستیاب ہیں۔` },
  { re: /^Already (\d+) seat\(s\) booked — can't set free seats below that\.$/, ur: (m) => `پہلے ہی ${m[1]} نشست(یں) بک ہو چکی ہیں — خالی نشستیں اس سے کم نہیں کی جا سکتیں۔` },
]

function translateAddaMessage(raw: string): string | null {
  if (ADDA_EXACT[raw]) return ADDA_EXACT[raw]
  for (const { re, ur } of ADDA_PATTERNS) {
    const m = raw.match(re)
    if (m) return ur(m)
  }
  return null
}
