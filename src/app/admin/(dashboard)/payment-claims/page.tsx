'use client'

import { useEffect, useState } from 'react'
import NextImage from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { CheckCircle, XCircle, Image as ImageIcon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Claim {
  id: string; bill_id: string; amount_pkr: number; payment_method: string; payment_proof_url: string
  note: string | null; status: string; created_at: string; consumer_id: string
  consumers: { name: string } | null; bills: { month: number; year: number; bill_number: string | null } | null
}

const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'short' })
function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function AdminPaymentClaimsPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('bill_payment_claims')
      .select('id, bill_id, amount_pkr, payment_method, payment_proof_url, note, status, created_at, consumer_id, consumers(name), bills(month, year, bill_number)')
      .eq('status', 'pending').order('created_at', { ascending: true })
    const list = (data ?? []) as unknown as Claim[]
    setClaims(list)
    setLoading(false)

    const urls: Record<string, string> = {}
    await Promise.all(list.map(async (c) => {
      const { data: signed } = await supabase.storage.from('bill_payment_proofs').createSignedUrl(c.payment_proof_url, 300)
      if (signed) urls[c.id] = signed.signedUrl
    }))
    setSignedUrls(urls)
  }
  useEffect(() => { load() }, [])

  const approve = async (id: string) => {
    setBusyId(id)
    const { error } = await supabase.rpc('approve_bill_payment_claim', { p_claim_id: id, p_review_note: null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pc.approved'))
    load()
  }

  const reject = async (id: string) => {
    setBusyId(id)
    const { error } = await supabase.rpc('reject_bill_payment_claim', { p_claim_id: id, p_review_note: null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pc.rejected'))
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canWaterSupply) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('pc.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('y.paymentClaims')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('pc.subtitle')}</p>
      </div>

      {loading ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></p>
      ) : claims.length === 0 ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('y.noPendingClaims')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {claims.map((c) => (
            <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex flex-col md:flex-row gap-5">
              {signedUrls[c.id] && (
                <a href={signedUrls[c.id]} target="_blank" rel="noopener noreferrer" className="relative shrink-0 w-full md:w-40 h-40 block">
                  <NextImage src={signedUrls[c.id]} alt="Payment slip" fill sizes="160px" className="object-cover rounded-lg border border-dp-outline-variant" />
                </a>
              )}
              <div className="flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-sans text-[15px] font-bold text-dp-on-surface">{c.consumers?.name ?? c.consumer_id} <span className="text-dp-on-surface-variant font-normal">· #{c.consumer_id}</span></p>
                    <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                      {c.bills ? `${monthName(c.bills.month)} ${c.bills.year}` : t('pc.billFallback')} {c.bills?.bill_number ? `(${c.bills.bill_number})` : ''} · {c.payment_method}
                    </p>
                  </div>
                  <p className="font-heading text-[20px] font-bold text-dp-secondary shrink-0">{fmt(c.amount_pkr)}</p>
                </div>
                {c.note && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-2">{c.note}</p>}
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant/70 mt-1">{t('pc.submittedPrefix')} {new Date(c.created_at).toLocaleDateString('en-GB')}</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => approve(c.id)} disabled={busyId === c.id} className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                    <CheckCircle size={14} /> {t('y.approvePost')}
                  </button>
                  <button onClick={() => reject(c.id)} disabled={busyId === c.id} className="flex items-center gap-1.5 px-4 py-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
                    <XCircle size={14} /> {t('ap.reject')}
                  </button>
                  {!signedUrls[c.id] && <span className="flex items-center gap-1 text-[12px] text-dp-on-surface-variant"><ImageIcon size={13} /> {t('y.noPreview')}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
