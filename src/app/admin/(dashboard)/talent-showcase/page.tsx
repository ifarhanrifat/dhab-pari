'use client'

// Talent Showcase (migration 333) — public cards about a talented
// villager: what they need, what they want to become, photos/videos. The
// safeguarding baseline locked in earlier this session (admin review
// before anything is public) is the whole shape of this page: nothing
// here ever auto-publishes, including staff-created entries.
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Sparkles, Plus, Pencil, Trash2, X, CheckCircle2, XCircle, Clock, ShieldCheck, HandHeart, Wallet, Award } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { VideoUpload } from '@/components/admin/VideoUpload'
import { VideoEmbed } from '@/components/public/VideoEmbed'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Entry {
  id: string; display_name: string; talent_description: string; needs: string | null; aspiration: string | null
  photo_url: string | null; video_url: string | null; moderation_status: string; is_published: boolean
  portal_user_id: string | null; submitted_by_admin_id: string | null; created_at: string
  needs_amount_pkr: number | null; support_status: string
}
interface HelpOffer { id: string; talent_showcase_id: string; message: string; status: string; created_at: string; supporter_name?: string }
interface Supporter { id: string; talent_showcase_id: string; donor_id: string | null; name: string; created_at: string }

const empty = { display_name: '', talent_description: '', needs: '', aspiration: '', photo_url: '', video_url: '', needs_amount_pkr: '', guardian_consent_confirmed_by_admin: false }
const SUPPORT_STATUSES = ['open', 'partially_supported', 'fulfilled']
const fmt = (n: number) => Math.round(n).toLocaleString()

export default function TalentShowcaseAdminPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [rows, setRows] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Entry | null>(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [raised, setRaised] = useState<Record<string, number>>({})
  const [offers, setOffers] = useState<HelpOffer[]>([])
  const [offersFor, setOffersFor] = useState<string | null>(null)
  const [supporters, setSupporters] = useState<Supporter[]>([])
  const [supportersFor, setSupportersFor] = useState<string | null>(null)
  const [donorNames, setDonorNames] = useState<string[]>([])
  const [helperOffers, setHelperOffers] = useState<{ name: string; portalUserId: string; offerId: string }[]>([])
  const [newSupporterName, setNewSupporterName] = useState('')
  const [addingSupporter, setAddingSupporter] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('talent_showcases').select('*').order('created_at', { ascending: false })
    const list = (data ?? []) as Entry[]
    setRows(list)
    setLoading(false)
    const fundable = list.filter((r) => r.needs_amount_pkr)
    if (fundable.length) {
      const pairs = await Promise.all(fundable.map(async (r) => {
        const { data: amt } = await supabase.rpc('talent_showcase_raised', { p_id: r.id })
        return [r.id, Number(amt ?? 0)] as const
      }))
      setRaised(Object.fromEntries(pairs))
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = () => { setForm(empty); setEditing(null); setShowForm(true) }
  const openEdit = (r: Entry) => {
    setForm({
      display_name: r.display_name, talent_description: r.talent_description,
      needs: r.needs ?? '', aspiration: r.aspiration ?? '', photo_url: r.photo_url ?? '', video_url: r.video_url ?? '',
      needs_amount_pkr: r.needs_amount_pkr?.toString() ?? '', guardian_consent_confirmed_by_admin: true,
    })
    setEditing(r)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.display_name.trim() || !form.talent_description.trim()) { toast.error(t('ts.nameDescRequired')); return }
    // Consent is confirmed once, at creation — editing an entry that
    // already exists (self-submitted or staff-authored) doesn't ask again.
    if (!editing && !form.guardian_consent_confirmed_by_admin) { toast.error(t('ts.consentRequired')); return }
    setSaving(true)
    const shared = {
      display_name: form.display_name.trim(), talent_description: form.talent_description.trim(),
      needs: form.needs.trim() || null, aspiration: form.aspiration.trim() || null,
      photo_url: form.photo_url || null, video_url: form.video_url || null,
      needs_amount_pkr: form.needs_amount_pkr ? parseFloat(form.needs_amount_pkr) : null,
    }
    if (editing) {
      const { error } = await supabase.from('talent_showcases').update(shared).eq('id', editing.id)
      setSaving(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ts.saved'))
    } else {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: admin } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
      const { error } = await supabase.from('talent_showcases').insert({
        ...shared, guardian_consent_confirmed_by_admin: true, submitted_by_admin_id: admin!.id,
      })
      setSaving(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ts.submitted'))
    }
    setForm(empty); setEditing(null); setShowForm(false)
    load()
  }

  const review = async (id: string, approve: boolean) => {
    setBusyId(id)
    const { error } = await supabase.from('talent_showcases').update({
      moderation_status: approve ? 'approved' : 'rejected', is_published: approve,
      reviewed_at: new Date().toISOString(),
    }).eq('id', id)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(approve ? t('ts.approved') : t('ts.rejected'))
    load()
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('talent_showcases').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ts.deleted'))
    load()
  }

  const changeSupportStatus = async (id: string, status: string) => {
    const { error } = await supabase.from('talent_showcases').update({ support_status: status }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, support_status: status } : r)))
  }

  const openOffers = async (id: string) => {
    setOffersFor(id)
    const { data } = await supabase.from('talent_showcase_help_offers').select('id, talent_showcase_id, message, status, created_at, portal_user_id').eq('talent_showcase_id', id).order('created_at', { ascending: false })
    const list = (data ?? []) as (HelpOffer & { portal_user_id: string })[]
    if (list.length) {
      const { data: names } = await supabase.from('portal_users').select('id, full_name').in('id', list.map((o) => o.portal_user_id))
      const nameMap = Object.fromEntries((names ?? []).map((n) => [n.id, n.full_name]))
      list.forEach((o) => { o.supporter_name = nameMap[o.portal_user_id] })
    }
    setOffers(list)
  }

  const markOfferStatus = async (id: string, status: string) => {
    const { error } = await supabase.from('talent_showcase_help_offers').update({ status }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)))
  }

  // "chose the name from all the donors, or set any name" — the general
  // donor list is loaded once (not scoped to this one entry) so any donor
  // who ever gave, however they gave it, can be picked. On top of that,
  // whoever called in on THIS entry's "I can help" offers is loaded fresh
  // each time and shown labeled distinctly in the picker — someone who
  // already said "I'll help" shouldn't have to be retyped by hand.
  const openSupporters = async (id: string) => {
    setSupportersFor(id)
    setNewSupporterName('')
    const { data } = await supabase.from('talent_showcase_supporters').select('id, talent_showcase_id, donor_id, name, created_at').eq('talent_showcase_id', id).order('created_at')
    setSupporters((data ?? []) as Supporter[])
    if (donorNames.length === 0) {
      const { data: donors } = await supabase.from('donors').select('name').order('date', { ascending: false }).limit(500)
      setDonorNames(Array.from(new Set((donors ?? []).map((d) => d.name).filter(Boolean))))
    }
    const { data: offerRows } = await supabase.from('talent_showcase_help_offers').select('id, portal_user_id').eq('talent_showcase_id', id)
    if (offerRows?.length) {
      const { data: names } = await supabase.from('portal_users').select('id, full_name').in('id', offerRows.map((o) => o.portal_user_id))
      const nameMap = Object.fromEntries((names ?? []).map((n) => [n.id, n.full_name]))
      setHelperOffers(offerRows.map((o) => ({ name: nameMap[o.portal_user_id], portalUserId: o.portal_user_id, offerId: o.id })).filter((h) => h.name))
    } else {
      setHelperOffers([])
    }
  }

  const addSupporter = async (talentShowcaseId: string) => {
    const name = newSupporterName.trim()
    if (!name) { toast.error(t('ts.supporterNameRequired')); return }
    setAddingSupporter(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: admin } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    // A typed name that exactly matches a known donor gets linked
    // (donor_id) for traceability; anything else is credited as-is.
    const { data: matchedDonor } = await supabase.from('donors').select('id').eq('name', name).order('date', { ascending: false }).limit(1).maybeSingle()
    const { data: row, error } = await supabase.from('talent_showcase_supporters').insert({
      talent_showcase_id: talentShowcaseId, name, donor_id: matchedDonor?.id ?? null, added_by: admin!.id,
    }).select('id, talent_showcase_id, donor_id, name, created_at').single()
    setAddingSupporter(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ts.supporterAdded'))
    setNewSupporterName('')
    setSupporters((prev) => [...prev, row as Supporter])
    // The person credited is the same one who called in offering to help
    // on this entry — label their offer resolved instead of leaving it
    // sitting there looking outstanding.
    const matchedOffer = helperOffers.find((h) => h.name === name)
    if (matchedOffer) {
      await supabase.from('talent_showcase_help_offers').update({ status: 'resolved' }).eq('id', matchedOffer.offerId)
      setOffers((prev) => prev.map((o) => (o.id === matchedOffer.offerId ? { ...o, status: 'resolved' } : o)))
    }
  }

  const removeSupporter = async (id: string) => {
    const { error } = await supabase.from('talent_showcase_supporters').delete().eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('ts.supporterRemoved'))
    setSupporters((prev) => prev.filter((s) => s.id !== id))
  }

  const pending = rows.filter((r) => r.moderation_status === 'pending')
  const reviewed = rows.filter((r) => r.moderation_status !== 'pending')

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <Sparkles size={26} className="text-dp-secondary" /> {t('ts.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('ts.blurb')}</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <Plus size={15} /> {t('ts.newEntry')}
        </button>
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}

      {!loading && pending.length > 0 && (
        <div className="mb-6">
          <h2 className="font-sans text-[13px] font-bold text-amber-700 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Clock size={14} /> {t('ts.pendingReview')} ({pending.length})</h2>
          <div className="space-y-2.5">
            {pending.map((r) => (
              <div key={r.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{r.display_name}</p>
                    <p className="font-sans text-[13px] text-dp-on-surface mt-1">{r.talent_description}</p>
                    {r.needs && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1"><strong>{t('ts.needsColon')}</strong> {r.needs}</p>}
                    {r.needs_amount_pkr && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5"><strong>{t('ts.needsAmountColon')}</strong> {fmt(r.needs_amount_pkr)}</p>}
                    {r.aspiration && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5"><strong>{t('ts.aspirationColon')}</strong> {r.aspiration}</p>}
                    {r.photo_url && <img src={r.photo_url} alt="" className="w-24 h-24 object-cover rounded-lg mt-2" />}
                    {r.video_url && <div className="max-w-xs mt-2"><VideoEmbed url={r.video_url} /></div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => review(r.id, true)} disabled={busyId === r.id} className="flex items-center gap-1 text-[12px] font-sans font-bold text-emerald-700 hover:underline cursor-pointer disabled:opacity-50"><CheckCircle2 size={13} /> {t('pa.approve')}</button>
                    <button onClick={() => review(r.id, false)} disabled={busyId === r.id} className="flex items-center gap-1 text-[12px] font-sans font-bold text-dp-error hover:underline cursor-pointer disabled:opacity-50"><XCircle size={13} /> {t('pa.reject')}</button>
                    <button onClick={() => openEdit(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={14} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && (
        <div>
          <h2 className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-2">{t('ts.allEntries')}</h2>
          {reviewed.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[13px]">{t('ts.none')}</p>}
          <div className="space-y-2.5">
            {reviewed.map((r) => (
              <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{r.display_name}</p>
                    {r.moderation_status === 'approved' ? (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">{t('sb.statusApproved')}</span>
                    ) : (
                      <span className="text-[10px] font-bold text-dp-error bg-dp-error/10 rounded-full px-2 py-0.5">{t('sb.statusRejected')}</span>
                    )}
                  </div>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.talent_description}</p>
                  {r.photo_url && <img src={r.photo_url} alt="" className="w-20 h-20 object-cover rounded-lg mt-2" />}
                  {r.video_url && <div className="max-w-xs mt-2"><VideoEmbed url={r.video_url} /></div>}

                  {r.moderation_status === 'approved' && (
                    <div className="mt-3 pt-3 border-t border-dp-outline-variant flex items-center gap-3 flex-wrap">
                      {r.needs_amount_pkr ? (
                        <span className="flex items-center gap-1.5 font-sans text-[12px] text-dp-on-surface"><Wallet size={13} className="text-dp-secondary" /> {fmt(raised[r.id] ?? 0)} / {fmt(r.needs_amount_pkr)}</span>
                      ) : null}
                      <select value={r.support_status} onChange={(e) => changeSupportStatus(r.id, e.target.value)} className="text-[11.5px] border border-dp-outline-variant rounded px-2 py-1">
                        {SUPPORT_STATUSES.map((s) => <option key={s} value={s}>{t(`ts.status.${s}`)}</option>)}
                      </select>
                      <button onClick={() => openOffers(r.id)} className="flex items-center gap-1 text-[11.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer"><HandHeart size={12} /> {t('ts.viewOffers')}</button>
                      <button onClick={() => (supportersFor === r.id ? setSupportersFor(null) : openSupporters(r.id))} className="flex items-center gap-1 text-[11.5px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer"><Award size={12} /> {t('ts.supporters')}</button>
                    </div>
                  )}

                  {offersFor === r.id && (
                    <div className="mt-2 space-y-1.5">
                      {offers.length === 0 ? (
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('ts.noOffers')}</p>
                      ) : offers.map((o) => (
                        <div key={o.id} className="bg-dp-surface-container-low rounded-lg px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-sans text-[12px] font-semibold text-dp-on-surface">{o.supporter_name}</span>
                            <select value={o.status} onChange={(e) => markOfferStatus(o.id, e.target.value)} className="text-[10.5px] border border-dp-outline-variant rounded px-1.5 py-0.5">
                              <option value="pending">{t('ts.offerPending')}</option>
                              <option value="contacted">{t('ts.offerContacted')}</option>
                              <option value="resolved">{t('ts.offerResolved')}</option>
                            </select>
                          </div>
                          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{o.message}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {supportersFor === r.id && (
                    <div className="mt-2 space-y-1.5">
                      {supporters.length === 0 ? (
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('ts.noSupporters')}</p>
                      ) : supporters.map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 bg-dp-surface-container-low rounded-lg px-3 py-1.5">
                          <span className="font-sans text-[12px] font-semibold text-dp-on-surface flex items-center gap-1.5">
                            {s.name}
                            {helperOffers.some((h) => h.name === s.name) && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-dp-secondary bg-dp-secondary/10 rounded-full px-1.5 py-0.5"><HandHeart size={10} /> {t('ts.calledToHelp')}</span>
                            )}
                          </span>
                          <button onClick={() => removeSupporter(s.id)} className="text-dp-error cursor-pointer"><X size={13} /></button>
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <input
                          list={`donor-names-${r.id}`} value={newSupporterName} onChange={(e) => setNewSupporterName(e.target.value)}
                          placeholder={`${t('ts.chooseDonor')} / ${t('ts.orCustomName')}`}
                          className="flex-1 text-[12px] border border-dp-outline-variant rounded-lg px-2.5 py-1.5"
                        />
                        <datalist id={`donor-names-${r.id}`}>
                          {helperOffers.map((h) => <option key={`offer-${h.offerId}`} value={h.name} label={`${h.name} — ${t('ts.calledToHelp')}`} />)}
                          {donorNames.map((n) => <option key={n} value={n} />)}
                        </datalist>
                        <button onClick={() => addSupporter(r.id)} disabled={addingSupporter} className="text-[11.5px] font-sans font-semibold bg-dp-secondary text-white px-3 py-1.5 rounded-lg cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
                          {t('ts.addSupporter')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => openEdit(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                  <button onClick={() => setConfirmDeleteId(r.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{editing ? t('ts.editEntry') : t('ts.newEntry')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.displayName')}</label>
                <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.talentDescription')}</label>
                <textarea value={form.talent_description} onChange={(e) => setForm({ ...form, talent_description: e.target.value })} rows={2} className="input-field resize-none" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.needs')}</label>
                <textarea value={form.needs} onChange={(e) => setForm({ ...form, needs: e.target.value })} placeholder={t('ts.needsPlaceholder')} rows={2} className="input-field resize-none" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.needsAmount')}</label>
                <input type="number" min="0" value={form.needs_amount_pkr} onChange={(e) => setForm({ ...form, needs_amount_pkr: e.target.value })} placeholder={t('ts.needsAmountPlaceholder')} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ts.aspiration')}</label>
                <input value={form.aspiration} onChange={(e) => setForm({ ...form, aspiration: e.target.value })} placeholder={t('ts.aspirationPlaceholder')} className="input-field" />
              </div>
              <ImageUpload bucket="images" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} label={t('ts.photo')} />
              <VideoUpload currentUrl={form.video_url} onUpload={(url) => setForm({ ...form, video_url: url })} />

              {!editing && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={form.guardian_consent_confirmed_by_admin} onChange={(e) => setForm({ ...form, guardian_consent_confirmed_by_admin: e.target.checked })} className="mt-0.5 w-4 h-4 accent-dp-secondary shrink-0" />
                    <span className="font-sans text-[12.5px] text-amber-900 leading-snug flex items-start gap-1.5"><ShieldCheck size={14} className="shrink-0 mt-0.5" /> {t('ts.consentCheckbox')}</span>
                  </label>
                </div>
              )}

              <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? t('action.saving') : editing ? t('action.save') : t('ts.submitForReview')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={!!confirmDeleteId} title={t('ts.deleteEntry')} message={t('ts.deleteConfirm')} onConfirm={remove} onCancel={() => setConfirmDeleteId(null)} />
    </div>
  )
}
