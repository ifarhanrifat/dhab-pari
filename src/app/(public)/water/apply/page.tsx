'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Droplets, CheckCircle, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function WaterApplyPage() {
  const [form, setForm] = useState({
    name: '',
    fatherName: '',
    mobile: '',
    cnic: '',
    address: '',
    sector: '',
    connectionType: 'residential',
  })
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.mobile.trim() || !form.address.trim()) {
      setError('Name, mobile, and address are required.')
      return
    }

    setLoading(true)
    setError('')

    const message = [
      `NEW WATER CONNECTION APPLICATION`,
      `Name: ${form.name}`,
      `Father Name: ${form.fatherName}`,
      `Mobile: ${form.mobile}`,
      `CNIC: ${form.cnic}`,
      `Address: ${form.address}`,
      `Sector: ${form.sector}`,
      `Connection Type: ${form.connectionType}`,
    ].join('\n')

    const { error: insertErr } = await supabase.from('suggestions').insert({
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      message,
      type: 'general',
    })

    if (insertErr) {
      setError('Failed to submit application. Please try again.')
      setLoading(false)
      return
    }

    setSubmitted(true)
    setLoading(false)
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      <div className="max-w-2xl mx-auto">
        {/* Back */}
        <Link
          href="/water"
          className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8"
        >
          <ArrowLeft size={16} />
          Back to Water Bill
        </Link>

        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-dp-primary-container rounded-full text-dp-on-primary-container mb-4">
            <Droplets size={32} />
          </div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
            New Water Connection
          </h1>
          <p className="text-dp-on-surface-variant font-sans text-[16px]">
            Apply for a new water connection for your household or shop.
          </p>
          <p
            className="text-dp-on-surface-variant text-[16px] mt-1"
            style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
          >
            نئے واٹر کنکشن کے لیے درخواست دیں
          </p>
        </div>

        {/* Success */}
        {submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center">
            <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-2">
              Application Submitted!
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px] mb-2">
              Your application has been received. The committee will review it
              and contact you within 3-5 working days.
            </p>
            <p
              className="text-dp-on-surface-variant text-[16px] mb-6"
              style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
            >
              آپ کی درخواست موصول ہو گئی ہے۔ کمیٹی 3-5 کاروباری دنوں میں آپ سے رابطہ کرے گی۔
            </p>
            <Link
              href="/water"
              className="inline-block bg-dp-secondary text-white px-8 py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all"
            >
              Back to Water Bill
            </Link>
          </div>
        )}

        {/* Form */}
        {!submitted && (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    NAME * / نام
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    FATHER NAME / والد کا نام
                  </label>
                  <input
                    type="text"
                    name="fatherName"
                    value={form.fatherName}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    MOBILE * / موبائل نمبر
                  </label>
                  <input
                    type="tel"
                    name="mobile"
                    value={form.mobile}
                    onChange={handleChange}
                    required
                    placeholder="0300-1234567"
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    CNIC / شناختی کارڈ نمبر
                  </label>
                  <input
                    type="text"
                    name="cnic"
                    value={form.cnic}
                    onChange={handleChange}
                    placeholder="xxxxx-xxxxxxx-x"
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  ADDRESS * / پتہ
                </label>
                <textarea
                  name="address"
                  value={form.address}
                  onChange={handleChange}
                  required
                  rows={3}
                  placeholder="House #, Street, Area"
                  className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px] resize-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    SECTOR / سیکٹر
                  </label>
                  <select
                    name="sector"
                    value={form.sector}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  >
                    <option value="">Select Sector</option>
                    <option value="Sector A">Sector A</option>
                    <option value="Sector B">Sector B</option>
                    <option value="Sector C">Sector C</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    CONNECTION TYPE / کنکشن کی قسم
                  </label>
                  <select
                    name="connectionType"
                    value={form.connectionType}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[16px]"
                  >
                    <option value="residential">Residential / رہائشی</option>
                    <option value="commercial">Commercial / تجارتی</option>
                  </select>
                </div>
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
                {loading ? 'Submitting...' : 'Submit Application / درخواست جمع کرائیں'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
