'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, CheckCircle } from 'lucide-react'

const tabs = [
  { key: 'suggestion', label: 'Suggestion', labelUr: 'تجویز' },
  { key: 'complaint', label: 'Complaint', labelUr: 'شکایت' },
  { key: 'volunteer', label: 'Volunteer', labelUr: 'رضاکار' },
  { key: 'general', label: 'General', labelUr: 'عام' },
]

export default function SuggestionsPage() {
  const [activeTab, setActiveTab] = useState('suggestion')
  const [name, setName] = useState('')
  const [mobile, setMobile] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim()) {
      setError('Message is required.')
      return
    }

    setLoading(true)
    setError('')

    const { error: insertErr } = await supabase.from('suggestions').insert({
      name: name.trim() || null,
      mobile: mobile.trim() || null,
      message: message.trim(),
      type: activeTab,
    })

    if (insertErr) {
      setError('Failed to submit. Please try again.')
      setLoading(false)
      return
    }

    setSubmitted(true)
    setLoading(false)
  }

  const reset = () => {
    setSubmitted(false)
    setName('')
    setMobile('')
    setMessage('')
    setError('')
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
            Community Input
          </h1>
          <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px]">
            Share your suggestions, complaints, or volunteer for village initiatives.
          </p>
          <p
            className="text-dp-on-surface-variant text-[18px] mt-2"
            style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
          >
            اپنی تجاویز، شکایات یا رضاکارانہ خدمات کے لیے رابطہ کریں
          </p>
        </div>

        {/* Tab Pills */}
        <div className="flex flex-wrap gap-3 mb-8 justify-center">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setSubmitted(false); setError('') }}
              className={`px-5 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
                activeTab === tab.key
                  ? 'bg-dp-primary text-white'
                  : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary hover:text-dp-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Success State */}
        {submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center">
            <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">
              Thank You!
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px] mb-2">
              Your {activeTab} has been submitted successfully.
            </p>
            <p
              className="text-dp-on-surface-variant text-[16px] mb-6"
              style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
            >
              آپ کی {tabs.find((t) => t.key === activeTab)?.labelUr} کامیابی سے جمع ہو گئی ہے۔
            </p>
            <button
              onClick={reset}
              className="bg-dp-secondary text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer"
            >
              Submit Another
            </button>
          </div>
        )}

        {/* Form */}
        {!submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  NAME (Optional) / نام
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-4 py-3 bg-[#fcf9f8] border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] text-dp-on-surface"
                />
              </div>

              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  MOBILE (Optional) / موبائل نمبر
                </label>
                <input
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="0300-1234567"
                  className="w-full px-4 py-3 bg-[#fcf9f8] border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] text-dp-on-surface"
                />
              </div>

              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  MESSAGE * / پیغام
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  rows={5}
                  placeholder={
                    activeTab === 'volunteer'
                      ? 'Tell us how you would like to help...'
                      : activeTab === 'complaint'
                        ? 'Describe your concern in detail...'
                        : 'Share your thoughts with the committee...'
                  }
                  className="w-full px-4 py-3 bg-[#fcf9f8] border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] text-dp-on-surface resize-none"
                />
              </div>

              {error && (
                <div className="bg-dp-error-container text-dp-on-error-container px-4 py-3 rounded-lg font-sans text-[14px]">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-dp-secondary text-white py-4 rounded-lg font-sans text-[18px] font-semibold hover:bg-dp-primary transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-50 cursor-pointer"
              >
                <Send size={18} />
                {loading ? 'Submitting...' : 'Submit / جمع کرائیں'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
