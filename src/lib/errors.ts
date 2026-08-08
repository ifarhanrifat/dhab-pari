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

interface PgLikeError {
  message?: string
  code?: string
  details?: string | null
  hint?: string | null
}

const PERMISSION_MESSAGE = "You don't have permission to do this. Ask an admin if you need access."

export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!error) return fallback

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
  ) return PERMISSION_MESSAGE

  // Not authenticated / session expired.
  if (code === 'PGRST301' || lower.includes('jwt expired') || lower.includes('invalid token')) {
    return 'Your session has expired. Please log in again.'
  }

  // Constraint violations, in plain language.
  if (code === '23505' || lower.includes('duplicate key')) {
    return 'This already exists — it looks like a duplicate.'
  }
  if (code === '23503' || lower.includes('violates foreign key')) {
    return "This can't be removed because other records still refer to it. Delete or reassign those first."
  }
  if (code === '23502' || lower.includes('null value in column')) {
    return 'A required field is missing.'
  }
  if (code === '23514' || lower.includes('violates check constraint')) {
    return "That value isn't allowed here. Please check the form and try again."
  }

  // Network / offline.
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
    return 'Could not reach the server. Check your internet connection and try again.'
  }

  // Our own RAISE EXCEPTION text from the SQL functions is already
  // human-readable and specific — show it as-is rather than burying it.
  // Postgres prefixes nothing to these, and they read like sentences.
  if (raw && !looksMachineGenerated(raw)) return raw

  return fallback
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
