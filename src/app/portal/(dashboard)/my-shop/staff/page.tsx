'use client'

// Multiple owners/staff on one shop (e.g. two brothers running it
// together) — migrations 458-462. Confirmed design (2026-09-08): full
// equal access, same as the original owner, not a tiered permission
// system. shops.portal_user_id stays the original account (never
// removable, so a shop can never end up with zero owners); every extra
// account gets a row in shop_staff and, from that point on, can do
// anything the original owner can — sell, restock, edit products/
// prices, manage customers/credit. Only the ORIGINAL owner can add or
// remove staff here (see shop_staff's own RLS) — a shop with several
// staff couldn't otherwise agree on who's allowed to remove whom.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Users, Plus, Trash2, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarqueeText } from '@/components/shared/MarqueeText'
import { ShopBottomNav } from '@/components/portal/ShopBottomNav'

const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

interface Shop { id: string; name: string; name_ur: string | null; portal_user_id: string }
interface StaffRow { id: string; portal_user_id: string; full_name: string; mobile: string; added_at: string }

export default function ShopStaffPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [isOriginalOwner, setIsOriginalOwner] = useState(false)
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [loading, setLoading] = useState(true)

  const [mobile, setMobile] = useState('')
  const [found, setFound] = useState<{ id: string; full_name: string } | null | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const loadStaff = (shopId: string) =>
    supabase.rpc('list_shop_staff', { p_shop_id: shopId }).then(({ data }) => setStaff((data ?? []) as StaffRow[]))

  useEffect(() => {
    if (!user) return
    // A staff member can also land here to just VIEW who else manages
    // the shop (their own shop_staff_owner_read policy allows that) —
    // shops.portal_user_id itself may not be their own row, so this
    // looks the shop up the same way user_manages_shop() does: either
    // owns it directly, or is a staff row for it.
    supabase.from('shops').select('id, name, name_ur, portal_user_id').eq('portal_user_id', user.id).maybeSingle().then(async ({ data: ownShop }) => {
      if (ownShop) {
        setShop(ownShop); setIsOriginalOwner(true)
        await loadStaff(ownShop.id)
        setLoading(false)
        return
      }
      const { data: staffRow } = await supabase.from('shop_staff').select('shop_id').eq('portal_user_id', user.id).maybeSingle()
      if (staffRow) {
        const { data: staffShop } = await supabase.from('shops').select('id, name, name_ur, portal_user_id').eq('id', staffRow.shop_id).maybeSingle()
        setShop(staffShop); setIsOriginalOwner(false)
        if (staffShop) await loadStaff(staffShop.id)
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const searchMobile = async () => {
    if (!mobile.trim()) return
    setSearching(true)
    const { data, error } = await supabase.rpc('find_portal_user_by_mobile', { p_mobile: mobile.trim() })
    setSearching(false)
    if (error) { toast.error(friendlyError(error)); return }
    setFound(data && data.length > 0 ? data[0] : null)
  }

  const addStaff = async () => {
    if (!shop || !found) return
    setAdding(true)
    const { error } = await supabase.from('shop_staff').insert({ shop_id: shop.id, portal_user_id: found.id })
    setAdding(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.staffAddedToast'))
    setMobile(''); setFound(undefined)
    loadStaff(shop.id)
  }

  const removeStaff = async (row: StaffRow) => {
    if (!shop || !confirm(t('sk.confirmRemoveStaff').replace('{name}', row.full_name))) return
    setRemovingId(row.id)
    const { error } = await supabase.from('shop_staff').delete().eq('id', row.id)
    setRemovingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.staffRemovedToast'))
    loadStaff(shop.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><Users size={22} /> {t('sk.staffHeading')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-4">{t('sk.staffSubtitle')}</p>

      {isOriginalOwner && (
        <div className="border border-[#dcd8d4] bg-white p-3.5 mb-4">
          <p className="font-sans text-[12px] font-semibold mb-2" style={{ color: INK }}>{t('sk.addStaffHeading')}</p>
          <div className="flex items-center gap-2">
            <input value={mobile} onChange={(e) => { setMobile(e.target.value); setFound(undefined) }} placeholder={t('sk.staffMobilePlaceholder')} className="input-field flex-1 ltr-num" dir="ltr" />
            <button onClick={searchMobile} disabled={searching || !mobile.trim()} className="shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 border font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ borderColor: ACCENT, color: ACCENT }}>
              {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} {t('sk.searchBtn')}
            </button>
          </div>
          {found === null && <p className="font-sans text-[12px] mt-2" style={{ color: ACCENT_DARK }}>{t('sk.noPortalUserFoundHint')}</p>}
          {found && (
            <div className="flex items-center justify-between gap-2 mt-2 p-2.5 border" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
              <span className="font-sans text-[13px] font-semibold" style={{ color: ACCENT_DARK }}>{found.full_name}</span>
              <button onClick={addStaff} disabled={adding} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-white font-sans text-[12px] font-semibold cursor-pointer disabled:opacity-50" style={{ background: ACCENT }}>
                {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {t('sk.addStaffBtn')}
              </button>
            </div>
          )}
          <p className="font-sans text-[10.5px] text-[#7a736d] mt-2">{t('sk.staffMustHaveAccountHint')}</p>
        </div>
      )}

      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-[#7a736d] mb-2">{t('sk.currentStaffHeading')}</p>
      {staff.length === 0 ? (
        <p className="text-center py-8 text-[#7a736d] font-sans text-[13px]">{t('sk.noStaffYetHint')}</p>
      ) : (
        <div className="space-y-1.5">
          {staff.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-white border border-[#dcd8d4]">
              <div className="min-w-0 flex-1">
                <MarqueeText text={row.full_name} className="font-sans text-[13.5px] font-semibold" style={{ color: INK }} />
                <p className="font-sans text-[11px] text-[#7a736d] ltr-num">{row.mobile}</p>
              </div>
              {isOriginalOwner && (
                <button onClick={() => removeStaff(row)} disabled={removingId === row.id} className="shrink-0 p-1.5 cursor-pointer disabled:opacity-50" style={{ color: ACCENT }}>
                  {removingId === row.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <ShopBottomNav />
    </div>
  )
}
