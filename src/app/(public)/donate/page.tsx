import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Donate',
  description: `Support ${SITE.name} village growth — donate via JazzCash, Easypaisa, or bank transfer.`,
}

// No per-visitor content — payment method details/instructions change rarely.
export const revalidate = 300
import Link from 'next/link'
import {
  Heart,
  Smartphone,
  Wallet,
  Building2,
  Copy,
  MessageCircle,
} from 'lucide-react'
import { DonateCTAButton } from '@/components/public/DonateCTAButton'
import { T } from '@/components/i18n/T'

export default async function DonatePage() {
  const supabase = await createClient()

  // donors_public (migration 116) — not the raw `donors` table, which is
  // staff-only now that it carries WhatsApp numbers, father's names, and
  // payment-screenshot URLs. The view already suppresses the name for
  // anonymous donors and exposes is_verified so "Announced" (pending
  // accountant verification) donations can be shown separately from the
  // honor wall.
  const [{ data: donors }, { data: announced }, { data: projectRows }] = await Promise.all([
    supabase.from('donors_public').select('id, name, amount_pkr, date, is_anonymous, project_id')
      .eq('is_verified', true).order('amount_pkr', { ascending: false }).limit(10),
    supabase.from('donors_public').select('id, name, amount_pkr, date, is_anonymous, project_id')
      .eq('is_verified', false).order('date', { ascending: false }).limit(10),
    supabase.from('projects').select('id, title, display_name'),
  ])

  const projectTitleById = new Map((projectRows ?? []).map((p) => [p.id, p.display_name || p.title]))
  const allDonors = donors ?? []
  const announcedDonors = announced ?? []

  const rankBadges: Record<number, string> = {
    0: 'bg-amber-400',
    1: 'bg-slate-300',
    2: 'bg-orange-300',
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-10 py-8">
      {/* Hero Quote */}
      <section className="mb-16">
        <div className="flex flex-col items-center text-center max-w-3xl mx-auto">
          <div className="mb-4 inline-flex items-center justify-center p-3 bg-dp-secondary-container rounded-full text-dp-on-secondary-container">
            <Heart size={32} />
          </div>
          <h1 className="font-heading text-[24px] md:text-[32px] font-bold leading-[32px] md:leading-[40px] mb-6 text-dp-primary section-title">
            <T k="x.supportVillageGrowth" />
          </h1>
          <div className="relative px-8 py-4 border-s-4 border-dp-secondary">
            <p className="font-sans text-[18px] leading-[28px] italic text-dp-on-surface-variant">
              &ldquo;The best of people are those who are most beneficial to
              others. Your contribution today is the seed for a prosperous Dhab
              Pari tomorrow.&rdquo;
            </p>
          </div>
        </div>
      </section>

      {/* Payment Channels */}
      <section className="mb-10">
        <h2 className="font-heading text-[20px] font-bold leading-[28px] mb-8 text-dp-primary border-b border-dp-outline-variant pb-4">
          <T k="x.securePayment" />
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* JazzCash */}
          <div className="bg-white border border-dp-outline-variant p-8 flex flex-col items-center text-center hover:border-dp-secondary transition-all rounded-lg">
            <div className="w-16 h-16 mb-6 flex items-center justify-center bg-red-500/10 rounded-lg">
              <Smartphone size={32} className="text-red-500" />
            </div>
            <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-2"><T k="w.jazzcash" /></h3>
            <p className="text-dp-on-surface-variant mb-6 font-sans text-[16px]">
              <T k="x.instantMobile" />
            </p>
            <div className="w-full bg-dp-surface-container p-4 rounded-lg flex items-center justify-between mb-4">
              <span className="font-bold text-dp-primary font-sans text-[18px] tracking-wider">
                {SITE.jazzcash}
              </span>
              <Copy size={16} className="text-dp-secondary cursor-pointer" />
            </div>
            <p className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]">
              Account Name: {SITE.jazzcashName}
            </p>
          </div>

          {/* Easypaisa */}
          <div className="bg-white border border-dp-outline-variant p-8 flex flex-col items-center text-center hover:border-dp-secondary transition-all rounded-lg">
            <div className="w-16 h-16 mb-6 flex items-center justify-center bg-emerald-500/10 rounded-lg">
              <Wallet size={32} className="text-emerald-500" />
            </div>
            <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-2"><T k="w.easypaisa" /></h3>
            <p className="text-dp-on-surface-variant mb-6 font-sans text-[16px]">
              <T k="x.easyAccessible" />
            </p>
            <div className="w-full bg-dp-surface-container p-4 rounded-lg flex items-center justify-between mb-4">
              <span className="font-bold text-dp-primary font-sans text-[18px] tracking-wider">
                {SITE.easypaisa}
              </span>
              <Copy size={16} className="text-dp-secondary cursor-pointer" />
            </div>
            <p className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]">
              Account Name: {SITE.easypaisaName}
            </p>
          </div>

          {/* Bank */}
          <div className="bg-white border border-dp-outline-variant p-8 flex flex-col items-center text-center hover:border-dp-secondary transition-all rounded-lg">
            <div className="w-16 h-16 mb-6 flex items-center justify-center bg-dp-primary-container/10 rounded-lg">
              <Building2 size={32} className="text-dp-primary" />
            </div>
            <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-2">
              Bank {SITE.bankName}
            </h3>
            <p className="text-dp-on-surface-variant mb-6 font-sans text-[16px]">
              <T k="x.directWire" />
            </p>
            <div className="w-full bg-dp-surface-container p-4 rounded-lg flex items-center justify-between mb-4">
              <span className="font-bold text-dp-primary font-sans text-[14px]">
                {SITE.bankAccount}
              </span>
              <Copy size={16} className="text-dp-secondary cursor-pointer" />
            </div>
            <p className="text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]">
              {SITE.bankBranch}
            </p>
          </div>
        </div>
      </section>

      {/* How to Contribute */}
      <section className="mb-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center bg-dp-surface-container-low p-8 md:p-12 rounded-lg">
        <div>
          <h2 className="font-heading text-[20px] font-bold leading-[28px] mb-6 text-dp-primary">
            <T k="x.howToContribute" />
          </h2>
          <div className="space-y-8">
            {[
              { n: '1', title: 'Select Channel', desc: 'Choose your preferred payment method from JazzCash, Easypaisa, or Bank Transfer.' },
              { n: '2', title: 'Make Payment', desc: 'Enter the account details and amount. Please include "Welfare" or "Project Name" in the reference.' },
              { n: '3', title: 'Submit Your Receipt', desc: 'Fill out our donation form with your details and upload the payment screenshot for verification.' },
            ].map((step) => (
              <div key={step.n} className="flex gap-4">
                <div className="w-10 h-10 shrink-0 bg-dp-primary text-white rounded-full flex items-center justify-center font-bold font-sans">
                  {step.n}
                </div>
                <div>
                  <h4 className="font-sans text-[18px] font-semibold leading-[28px] mb-1">{step.title}</h4>
                  <p className="text-dp-on-surface-variant font-sans text-[16px]">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap gap-4">
            <DonateCTAButton className="inline-flex items-center gap-2 bg-dp-primary text-white px-8 py-3 rounded-lg font-bold font-sans hover:bg-dp-primary-container transition-all" />
            <a
              href={SITE.whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border border-dp-outline-variant text-dp-primary px-8 py-3 rounded-lg font-bold font-sans hover:bg-dp-surface-container transition-all"
            >
              <MessageCircle size={18} />
              <T k="x.contactWhatsapp" />
            </a>
          </div>
        </div>
        <div className="relative aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container flex items-center justify-center">
          <Heart size={80} className="text-white/20" />
        </div>
      </section>

      {/* Donors Honor Wall */}
      <section className="mb-10">
        <div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-4">
          <div>
            <h2 className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary">
              <T k="x.donorsHonorWall" />
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px]">
              <T k="x.transparentRecord" />
            </p>
          </div>
          <span className="px-4 py-1 bg-dp-secondary-container text-dp-on-secondary-container rounded-full text-[14px] font-sans font-bold tracking-[0.05em] shrink-0">
            Total Raised: Rs. 1.2M
          </span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-dp-outline-variant bg-white">
          <table className="w-full text-start border-collapse">
            <thead className="bg-dp-primary text-white">
              <tr>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase"><T k="x.rank" /></th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase"><T k="x.name" /></th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase"><T k="w.amountPkr" /></th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase"><T k="w.date" /></th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase"><T k="w.project" /></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dp-outline-variant">
              {allDonors.map((donor, i) => {
                const project = donor.project_id ? { title: projectTitleById.get(donor.project_id) } : null
                return (
                  <tr key={donor.id} className="hover:bg-dp-surface-container transition-colors">
                    <td className="px-6 py-4">
                      {i < 3 ? (
                        <span className={`w-8 h-8 flex items-center justify-center ${rankBadges[i]} text-white rounded-full font-bold font-sans text-[14px]`}>
                          {i + 1}
                        </span>
                      ) : (
                        <span className="w-8 h-8 flex items-center justify-center text-dp-on-surface-variant font-bold font-sans text-[14px]">
                          {i + 1}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 font-bold text-dp-primary font-sans">
                      {donor.is_anonymous ? 'Anonymous Donor' : donor.name}
                    </td>
                    <td className="px-6 py-4 font-bold font-sans">
                      Rs. {Number(donor.amount_pkr).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-dp-on-surface-variant font-sans">
                      {formatDate(donor.date)}
                    </td>
                    <td className="px-6 py-4">
                      {project?.title ? (
                        <span className="bg-dp-secondary-container/50 text-dp-on-secondary-container px-3 py-1 rounded text-[14px] font-sans font-bold tracking-[0.05em]">
                          {project.title}
                        </span>
                      ) : (
                        <span className="bg-dp-surface-container px-3 py-1 rounded text-[14px] font-sans text-dp-on-surface-variant">
                          <T k="w.generalFund" />
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 text-center">
          <button className="text-dp-secondary font-bold hover:underline font-sans cursor-pointer">
            View All 150+ Donors
          </button>
        </div>
      </section>

      {/* Announced Funds — submitted but pending accountant verification */}
      {announcedDonors.length > 0 && (
        <section className="mb-10">
          <div className="mb-6">
            <h2 className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary">
              <T k="x.announcedFunds" />
            </h2>
            <p className="text-dp-on-surface-variant font-sans text-[16px]">
              <T k="x.pendingVerification" />
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-dp-outline-variant bg-white">
            <table className="w-full text-start border-collapse">
              <thead className="bg-dp-surface-container-low">
                <tr>
                  <th className="px-6 py-3 font-sans text-[13px] font-semibold tracking-[0.05em] uppercase text-dp-on-surface-variant"><T k="x.name" /></th>
                  <th className="px-6 py-3 font-sans text-[13px] font-semibold tracking-[0.05em] uppercase text-dp-on-surface-variant"><T k="w.amountPkr" /></th>
                  <th className="px-6 py-3 font-sans text-[13px] font-semibold tracking-[0.05em] uppercase text-dp-on-surface-variant"><T k="w.project" /></th>
                  <th className="px-6 py-3 font-sans text-[13px] font-semibold tracking-[0.05em] uppercase text-dp-on-surface-variant"><T k="w.status" /></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dp-outline-variant">
                {announcedDonors.map((donor) => (
                  <tr key={donor.id}>
                    <td className="px-6 py-4 font-bold text-dp-primary font-sans">{donor.is_anonymous ? 'Anonymous Donor' : donor.name}</td>
                    <td className="px-6 py-4 font-bold font-sans">Rs. {Number(donor.amount_pkr).toLocaleString()}</td>
                    <td className="px-6 py-4 font-sans text-dp-on-surface-variant">{donor.project_id ? (projectTitleById.get(donor.project_id) ?? 'Project') : 'General Fund'}</td>
                    <td className="px-6 py-4">
                      <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded text-[12px] font-sans font-bold tracking-[0.05em]"><T k="x.announced" /></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
