'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff, ShieldAlert, Lock, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const MIN_DELAY_MS = 1000   // 1 s after first failure, doubles each time
const MAX_DELAY_MS = 8000   // cap at 8 s

export default function AdminLoginPage() {
  const { t } = useLocale()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [lockedUntil, setLockedUntil] = useState(0)    // epoch ms
  const [countdown, setCountdown]     = useState(0)    // seconds remaining
  const [failCount, setFailCount]     = useState(0)
  const [delayLeft, setDelayLeft]     = useState(0)    // cooldown between retries
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const router   = useRouter()

  // Countdown for server-side lockout
  useEffect(() => {
    if (lockedUntil === 0) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000))
      setCountdown(left)
      if (left === 0) setLockedUntil(0)
    }
    tick()
    timerRef.current = setInterval(tick, 1000)
    return () => clearInterval(timerRef.current!)
  }, [lockedUntil])

  // Progressive delay countdown between attempts
  useEffect(() => {
    if (delayLeft <= 0) return
    const t = setInterval(() => {
      setDelayLeft((d) => {
        if (d <= 1) { clearInterval(t); return 0 }
        return d - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [delayLeft])

  const isLocked   = lockedUntil > Date.now()
  const isThrottled = delayLeft > 0

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isLocked || isThrottled || loading) return

    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        credentials: 'same-origin',
      })

      const data = await res.json()

      if (res.ok) {
        setFailCount(0)
        router.push('/admin')
        router.refresh()
        return
      }

      // Server-side lockout
      if (res.status === 429 && data.retryAfter) {
        setLockedUntil(Date.now() + data.retryAfter * 1000)
        setError(data.error ?? 'Too many attempts. You are temporarily locked out.')
        setLoading(false)
        return
      }

      // Normal failure — apply progressive client-side delay
      const newFail = failCount + 1
      setFailCount(newFail)
      setError(data.error ?? 'Invalid credentials.')

      if (newFail >= 2) {
        const delay = Math.min(MIN_DELAY_MS * Math.pow(2, newFail - 2), MAX_DELAY_MS)
        setDelayLeft(Math.ceil(delay / 1000))
      }

      // If server says near lockout, pre-empt
      if (data.retryAfter > 0) {
        setLockedUntil(Date.now() + data.retryAfter * 1000)
      }
    } catch {
      setError('Network error. Please check your connection and try again.')
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#E1F5EE] flex flex-col">
      {/* Header */}
      <header className="bg-dp-primary w-full px-6 py-4">
        <div className="max-w-[1200px] mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
            <Lock size={18} className="text-white" />
          </div>
          <div>
            <h1 className="font-heading text-[24px] font-bold leading-[32px] text-white">
              {SITE.name}
            </h1>
            <p className="text-white/60 text-[12px] font-sans">
              Admin Portal — Restricted Access
            </p>
          </div>
        </div>
      </header>

      {/* Login Card */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 shadow-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-dp-primary-container rounded-full mb-3">
              <ShieldAlert size={22} className="text-dp-on-primary-container" />
            </div>
            <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-1">
              Admin Login
            </h2>
            <p className="text-dp-on-surface-variant text-[13px] font-sans">
              Authorised personnel only
            </p>
          </div>

          {/* Server lockout banner */}
          {isLocked && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-sans text-[14px] font-bold text-red-700">Account temporarily locked</p>
                <p className="font-sans text-[13px] text-red-600 mt-0.5">
                  Too many failed attempts. Try again in{' '}
                  <span className="font-bold tabular-nums">
                    {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                  </span>
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans"
              >
                {t('a.email')}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                disabled={isLocked || loading}
                className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="admin@dhabpari.com"
              />
            </div>

            {/* Password */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="password"
                  className="block text-[13px] font-bold text-dp-on-surface-variant tracking-[0.06em] uppercase font-sans"
                >
                  {t('w.password')}
                </label>
                <Link href="/admin/forgot-password" className="font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  disabled={isLocked || loading}
                  className="w-full px-4 py-3 pe-12 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1"
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && !isLocked && (
              <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isLocked || isThrottled || loading}
              className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLocked
                ? `Locked — wait ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
                : isThrottled
                ? `Please wait ${delayLeft}s...`
                : loading
                ? 'Signing in...'
                : 'Sign In'}
            </button>
          </form>

          {/* Attempt warning */}
          {failCount >= 2 && !isLocked && (
            <p className="text-center font-sans text-[12px] text-dp-error mt-4">
              {5 - failCount <= 0
                ? 'You have been locked out.'
                : `Warning: ${5 - failCount} attempt${5 - failCount === 1 ? '' : 's'} left before lockout.`}
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center py-4 text-dp-on-surface-variant text-[12px] font-sans">
        © {new Date().getFullYear()} {SITE.fullName} — All access is logged
      </div>
    </div>
  )
}
