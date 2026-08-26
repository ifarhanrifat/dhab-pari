'use client'

// Registered donor/consumer portal accounts — the one gap the Donor Badges
// and Donors pages didn't cover: nowhere to block a login, reset a
// forgotten password, or fix a mislinked consumer/donor account. Reuses the
// exact staff-user-management pattern (/admin/users) one level down.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, UserCog, Lock, Ban, CheckCircle2, Trash2, Link2, Unlink, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { DonorBadge } from '@/components/public/DonorBadge'
import { SearchableField } from '@/components/admin/SearchablePicker'
import type { DonorBadgeTier } from '@/lib/donorBadges'

interface PortalUser {
  id: string; full_name: string; name_ur: string | null; mobile: string; username: string | null
  is_active: boolean; consumer_id: string | null; donor_account_id: string | null
  manual_badge_tier: DonorBadgeTier | null; created_at: string; auth_user_id: string | null
  phone_private: boolean; seeking_mentorship: boolean
  mentor_status: string; mentor_type: string | null; mentor_bio: string | null; mentor_expertise: string | null
}
interface ConsumerOpt { consumer_id: string; name: string | null }
interface DonorAccountOpt { id: string; name: string; donor_account_no: string | null; donor_key: string | null }

export default function PortalAccountsPage() {
  const { t, isUrdu } = useLocale()
  const [rows, setRows] = useState<PortalUser[]>([])
  const [consumers, setConsumers] = useState<ConsumerOpt[]>([])
  const [donorAccounts, setDonorAccounts] = useState<DonorAccountOpt[]>([])
  const [badgeByUser, setBadgeByUser] = useState<Record<string, DonorBadgeTier>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [passwordFor, setPasswordFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [linkingFor, setLinkingFor] = useState<string | null>(null)
  const [linkConsumerId, setLinkConsumerId] = useState('')
  const [linkingDonorFor, setLinkingDonorFor] = useState<string | null>(null)
  const [linkDonorAccountId, setLinkDonorAccountId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const [{ data }, { data: cons }, { data: donorAccts }] = await Promise.all([
      supabase.from('portal_users').select('id, full_name, name_ur, mobile, username, is_active, consumer_id, donor_account_id, manual_badge_tier, created_at, auth_user_id, phone_private, seeking_mentorship, mentor_status, mentor_type, mentor_bio, mentor_expertise').order('created_at', { ascending: false }),
      supabase.from('consumers').select('consumer_id, name').order('consumer_id'),
      // Same identity every auto-match (signup, confirm_donation, pool
      // payments) already links against — donor_key doubles as the phone
      // number when one was ever recorded, so it's included in the
      // searchable label without needing a separate phone column here.
      supabase.from('accounts').select('id, name, donor_account_no, donor_key').eq('system', 'donors_projects').eq('type', 'donor').order('name'),
    ])
    const list = (data ?? []) as PortalUser[]
    setRows(list)
    setConsumers((cons ?? []) as ConsumerOpt[])
    setDonorAccounts((donorAccts ?? []) as DonorAccountOpt[])
    setLoading(false)
    const ids = list.filter((r) => r.donor_account_id).map((r) => r.id)
    if (ids.length) {
      const pairs = await Promise.all(ids.map(async (id) => {
        const { data: tier } = await supabase.rpc('donor_badge_tier', { p_portal_user_id: id })
        return [id, tier] as const
      }))
      setBadgeByUser(Object.fromEntries(pairs.filter(([, tier]) => tier)))
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.full_name.toLowerCase().includes(q) || (r.username ?? '').toLowerCase().includes(q) || r.mobile.includes(q))
  }, [rows, search])

  const toggleActive = async (r: PortalUser) => {
    setBusyId(r.id)
    // Goes through the API route (not a direct client update) — blocking
    // also bans the underlying auth.users row so it takes effect on the
    // account's very next request, not just whenever something happens to
    // re-check is_active.
    const res = await fetch('/api/admin/portal-users/set-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUserId: r.id, active: !r.is_active }),
    })
    const body = await res.json()
    setBusyId(null)
    if (!res.ok) { toast.error(body.error ?? t('pa.genericError')); return }
    toast.success(r.is_active ? t('pa.blockedToast') : t('pa.unblockedToast'))
    load()
  }

  const resetPassword = async () => {
    if (!passwordFor || newPassword.length < 8) { toast.error(t('pa.passwordTooShort')); return }
    setBusyId(passwordFor)
    const res = await fetch('/api/admin/portal-users/set-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUserId: passwordFor, password: newPassword }),
    })
    const body = await res.json()
    setBusyId(null)
    if (!res.ok) { toast.error(body.error ?? t('pa.genericError')); return }
    toast.success(t('pa.passwordResetToast'))
    setPasswordFor(null); setNewPassword('')
  }

  const saveLink = async () => {
    if (!linkingFor) return
    setBusyId(linkingFor)
    const { error } = await supabase.from('portal_users').update({ consumer_id: linkConsumerId || null }).eq('id', linkingFor)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pa.linkedToast'))
    setLinkingFor(null); setLinkConsumerId('')
    load()
  }

  const unlinkDonor = async (r: PortalUser) => {
    setBusyId(r.id)
    const { error } = await supabase.from('portal_users').update({ donor_account_id: null }).eq('id', r.id)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pa.unlinkedToast'))
    load()
  }

  // The manual counterpart to the automatic phone-match at signup/
  // confirm_donation — for when it missed (no phone was ever recorded on
  // the old donation, or the number's changed since) and staff have
  // verified through some other means (a conversation, a screenshot) which
  // real donor account this portal login actually belongs to.
  const saveLinkDonor = async () => {
    if (!linkingDonorFor) return
    setBusyId(linkingDonorFor)
    const { error } = await supabase.from('portal_users').update({ donor_account_id: linkDonorAccountId || null }).eq('id', linkingDonorFor)
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pa.linkedToast'))
    setLinkingDonorFor(null); setLinkDonorAccountId('')
    load()
  }

  const reviewMentor = async (r: PortalUser, approve: boolean) => {
    setBusyId(r.id)
    const { error } = await supabase.rpc('review_mentor_request', { p_portal_user_id: r.id, p_approve: approve })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(approve ? t('pa.mentorApproved') : t('pa.mentorRejected'))
    load()
  }

  const remove = async () => {
    if (!confirmDeleteId) return
    setBusyId(confirmDeleteId)
    const res = await fetch('/api/admin/portal-users/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalUserId: confirmDeleteId }),
    })
    const body = await res.json()
    setBusyId(null)
    setConfirmDeleteId(null)
    if (!res.ok) { toast.error(body.error ?? t('pa.genericError')); return }
    toast.success(t('pa.deletedToast'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
          <UserCog size={26} className="text-dp-secondary" /> {t('pa.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pa.blurb')}</p>
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-dp-on-surface-variant" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('pa.searchPlaceholder')} className="input-field ps-9" />
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
      {!loading && filtered.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('pa.noAccounts')}</div>}

      <div className="space-y-2.5">
        {!loading && filtered.map((r) => (
          <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{r.full_name}</p>
                  {r.username && <span className="font-sans text-[12px] text-dp-on-surface-variant">@{r.username}</span>}
                  {r.is_active
                    ? <span className="font-sans text-[10px] font-bold text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">{t('g.active')}</span>
                    : <span className="font-sans text-[10px] font-bold text-dp-error bg-dp-error/10 rounded-full px-2 py-0.5">{t('pa.blocked')}</span>}
                  <DonorBadge tier={badgeByUser[r.id]} isUrdu={isUrdu} size="xs" />
                  {r.mentor_status === 'approved' && <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 rounded-full px-2 py-0.5">{t('pa.mentorApprovedBadge')}</span>}
                  {r.mentor_status === 'pending' && <span className="text-[10px] font-bold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t('pa.mentorPendingBadge')}</span>}
                </div>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 flex items-center gap-1.5">
                  {r.mobile}
                  {r.phone_private && <span title={t('pa.phonePrivateHint')} className="inline-flex items-center gap-0.5 text-[10px] font-bold text-dp-secondary"><Lock size={10} /> {t('pa.private')}</span>}
                  {r.seeking_mentorship && <span className="text-[10px] font-bold text-amber-700 bg-amber-50 rounded-full px-1.5 py-0.5">{t('pa.seekingMentorship')}</span>}
                </p>
                {r.mentor_status === 'pending' && (
                  <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-md">
                    <p className="font-sans text-[11.5px] text-amber-900"><strong>{r.mentor_type === 'professional' ? t('mn.typeProfessional') : t('mn.typeFreelancer')}</strong> — {r.mentor_expertise}</p>
                    {r.mentor_bio && <p className="font-sans text-[11.5px] text-amber-900 mt-0.5">{r.mentor_bio}</p>}
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={() => reviewMentor(r, true)} disabled={busyId === r.id} className="flex items-center gap-1 text-[11.5px] font-sans font-bold text-emerald-700 hover:underline cursor-pointer disabled:opacity-50">
                        <CheckCircle2 size={12} /> {t('pa.approve')}
                      </button>
                      <button onClick={() => reviewMentor(r, false)} disabled={busyId === r.id} className="flex items-center gap-1 text-[11.5px] font-sans font-bold text-dp-error hover:underline cursor-pointer disabled:opacity-50">
                        <XCircle size={12} /> {t('pa.reject')}
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <span className="font-sans text-[12px] text-dp-on-surface-variant">
                    {t('pa.consumerLabel')}: {r.consumer_id ? <strong className="text-dp-on-surface">{r.consumer_id}</strong> : t('pa.none')}
                  </span>
                  <button onClick={() => { setLinkingFor(r.id); setLinkConsumerId(r.consumer_id ?? '') }} className="text-dp-secondary text-[11.5px] font-sans font-semibold hover:underline cursor-pointer flex items-center gap-1">
                    <Link2 size={11} /> {t('pa.editLink')}
                  </button>
                  <span className="font-sans text-[12px] text-dp-on-surface-variant">
                    {t('pa.donorAccountLabel')}: {r.donor_account_id ? <strong className="text-dp-on-surface">{donorAccounts.find((a) => a.id === r.donor_account_id)?.donor_account_no ?? donorAccounts.find((a) => a.id === r.donor_account_id)?.name ?? '—'}</strong> : t('pa.none')}
                  </span>
                  <button onClick={() => { setLinkingDonorFor(r.id); setLinkDonorAccountId(r.donor_account_id ?? '') }} className="text-dp-secondary text-[11.5px] font-sans font-semibold hover:underline cursor-pointer flex items-center gap-1">
                    <Link2 size={11} /> {t('pa.editDonorLink')}
                  </button>
                  {r.donor_account_id && (
                    <button onClick={() => unlinkDonor(r)} className="text-dp-error text-[11.5px] font-sans font-semibold hover:underline cursor-pointer flex items-center gap-1">
                      <Unlink size={11} /> {t('pa.unlinkDonor')}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                <button onClick={() => toggleActive(r)} disabled={busyId === r.id}
                  className={`px-3 py-1.5 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer transition-all flex items-center gap-1.5 disabled:opacity-50 ${r.is_active ? 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>
                  {r.is_active ? <><Ban size={13} /> {t('pa.block')}</> : <><CheckCircle2 size={13} /> {t('pa.unblock')}</>}
                </button>
                {r.auth_user_id && (
                  <button onClick={() => setPasswordFor(r.id)} className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer flex items-center gap-1.5">
                    <Lock size={13} /> {t('pa.resetPassword')}
                  </button>
                )}
                <button onClick={() => setConfirmDeleteId(r.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {passwordFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPasswordFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pa.resetPassword')}</h2>
              <button onClick={() => setPasswordFor(null)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <input autoFocus type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t('pa.newPasswordPlaceholder')} className="input-field mb-4" />
            <button disabled={busyId === passwordFor} onClick={resetPassword} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {t('pa.confirmReset')}
            </button>
          </div>
        </div>
      )}

      {linkingFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setLinkingFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pa.editLink')}</h2>
              <button onClick={() => setLinkingFor(null)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pa.consumerLabel')}</label>
            <select value={linkConsumerId} onChange={(e) => setLinkConsumerId(e.target.value)} className="input-field mb-4">
              <option value="">{t('pa.none')}</option>
              {consumers.map((c) => <option key={c.consumer_id} value={c.consumer_id}>{c.consumer_id}{c.name ? ` — ${c.name}` : ''}</option>)}
            </select>
            <button disabled={busyId === linkingFor} onClick={saveLink} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {t('action.save')}
            </button>
          </div>
        </div>
      )}

      {linkingDonorFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setLinkingDonorFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pa.editDonorLink')}</h2>
              <button onClick={() => setLinkingDonorFor(null)} className="cursor-pointer"><X size={18} /></button>
            </div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pa.donorAccountLabel')}</label>
            <SearchableField
              value={linkDonorAccountId}
              onChange={setLinkDonorAccountId}
              placeholder={t('pa.selectDonorAccount')}
              items={donorAccounts.map((a) => ({
                id: a.id,
                label: `${a.donor_account_no ?? '—'} — ${a.name}${a.donor_key ? ` · ${a.donor_key}` : ''}`,
              }))}
            />
            <button disabled={busyId === linkingDonorFor} onClick={saveLinkDonor} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 mt-4">
              {t('action.save')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title={t('pa.confirmDeleteTitle')}
        message={t('pa.confirmDeleteMessage')}
        onConfirm={remove}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  )
}
