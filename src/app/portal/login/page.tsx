'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff, HeartHandshake, AlertTriangle } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 8000

export default function PortalLoginPage() {
  const { t } = useLocale()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [failCount, setFailCount] = useState(0)
  const [delayLeft, setDelayLeft] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const router = useRouter()

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

  useEffect(() => {
    if (delayLeft <= 0) return
    const t = setInterval(() => {
      setDelayLeft((d) => { if (d <= 1) { clearInterval(t); return 0 }; return d - 1 })
    }, 1000)
    return () => clearInterval(t)
  }, [delayLeft])

  const isLocked = lockedUntil > Date.now()
  const isThrottled = delayLeft > 0

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isLocked || isThrottled || loading) return
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/portal/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }), credentials: 'same-origin',
      })
      const data = await res.json()

      if (res.ok) {
        setFailCount(0)
        router.push('/portal')
        router.refresh()
        return
      }
      if (res.status === 429 && data.retryAfter) {
        setLockedUntil(Date.now() + data.retryAfter * 1000)
        setError(data.error ?? 'Too many attempts. You are temporarily locked out.')
        setLoading(false)
        return
      }
      const newFail = failCount + 1
      setFailCount(newFail)
      setError(data.error ?? 'Invalid credentials.')
      if (newFail >= 2) setDelayLeft(Math.ceil(Math.min(MIN_DELAY_MS * Math.pow(2, newFail - 2), MAX_DELAY_MS) / 1000))
      if (data.retryAfter > 0) setLockedUntil(Date.now() + data.retryAfter * 1000)
    } catch {
      setError('Network error. Please check your connection and try again.')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#E1F5EE] flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-dp-primary flex items-center justify-center text-white mb-4">
          <HeartHandshake size={26} />
        </div>
        <h1 className="font-heading text-[24px] font-bold text-dp-primary">Donor &amp; Consumer Portal</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{SITE.shortCommittee}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-sm">
        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label htmlFor="username" className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">Username</label>
            <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required
              autoComplete="username" disabled={isLocked || loading}
              className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans disabled:opacity-50"
              placeholder="Your username" />
          </div>
          <div>
            <label htmlFor="password" className="block text-[13px] font-bold text-dp-on-surface-variant mb-2 tracking-[0.06em] uppercase font-sans">{t('w.password')}</label>
            <div className="relative">
              <input id="password" type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
                autoComplete="current-password" disabled={isLocked || loading}
                className="w-full px-4 py-3 pe-12 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans disabled:opacity-50"
                placeholder="••••••••" />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant cursor-pointer p-1" tabIndex={-1}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && !isLocked && (
            <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={isLocked || isThrottled || loading}
            className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {isLocked ? `Locked — wait ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
              : isThrottled ? `Wait ${delayLeft}s...`
              : loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <p className="text-center font-sans text-[14px] text-dp-on-surface-variant mt-6">
          {t('p.newHere')} <Link href="/portal/signup" className="text-dp-secondary font-semibold hover:underline">{t('p.createAnAccount')}</Link>
        </p>
      </div>
    </div>
  )
}
