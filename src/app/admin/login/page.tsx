'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function AdminLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    router.push('/admin')
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-[#fcf9f8] flex flex-col">
      {/* Header */}
      <header className="bg-dp-primary w-full px-6 py-4">
        <div className="max-w-[1200px] mx-auto">
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-white">
            Dhab Pari
          </h1>
          <p className="text-white/60 text-[12px] font-sans">
            Admin Portal
          </p>
        </div>
      </header>

      {/* Login Card */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8">
          <div className="text-center mb-8">
            <h2 className="font-heading text-[24px] font-bold text-dp-primary mb-2">
              Admin Login
            </h2>
            <p className="text-dp-on-surface-variant text-[14px] font-sans">
              Sign in to manage the village portal
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label
                htmlFor="email"
                className="block text-[14px] font-semibold text-dp-on-surface-variant mb-2 tracking-[0.05em] uppercase font-sans"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 bg-[#fcf9f8] border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface"
                placeholder="admin@dhabpari.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-[14px] font-semibold text-dp-on-surface-variant mb-2 tracking-[0.05em] uppercase font-sans"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-3 bg-[#fcf9f8] border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all text-[16px] font-sans text-dp-on-surface"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg text-[14px] font-sans">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold text-[16px] hover:bg-dp-primary-container transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center py-4 text-dp-on-surface-variant text-[12px] font-sans">
        © 2024 Dhab Pari Water & Welfare Committee
      </div>
    </div>
  )
}
