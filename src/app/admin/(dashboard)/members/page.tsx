'use client'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Member {
  id: string; name: string; name_ur: string | null; position: string; position_ur: string | null; phone: string | null
  bio: string | null; bio_ur: string | null; display_order: number; is_active: boolean; photo_url: string | null
  admin_user_id: string | null; proxy_admin_user_id: string | null; uses_smartphone: boolean; handles_non_whatsapp_notice: boolean
}
interface AdminUserOpt { id: string; full_name: string }
const empty = {
  name: '', name_ur: '', position: '', position_ur: '', phone: '', bio: '', bio_ur: '', display_order: 0, is_active: true, photo_url: '',
  admin_user_id: '', proxy_admin_user_id: '', uses_smartphone: true, handles_non_whatsapp_notice: false,
}

export default function AdminMembersPage() {
  const { t } = useLocale()
  const [members, setMembers] = useState<Member[]>([])
  const [adminUsers, setAdminUsers] = useState<AdminUserOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const [membersRes, adminUsersRes] = await Promise.all([
      supabase.from('committee_members').select('*').order('display_order'),
      // Used to link a committee member to their own login (or a fixed standing
      // proxy for the members without smartphones) — see Meetings & Agenda.
      // Only visible for admin-tier callers per admin_users RLS; degrades
      // gracefully to an empty list otherwise (fields just show "Not linked").
      supabase.from('admin_users').select('id, full_name').eq('is_active', true).order('full_name'),
    ])
    setMembers(membersRes.data ?? [])
    setAdminUsers(adminUsersRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const adminUserName = (id: string | null) => adminUsers.find((a) => a.id === id)?.full_name ?? null

  const save = async () => {
    if (!form.name.trim() || !form.position.trim()) { toast.error('Name and position required'); return }
    const payload = {
      ...form, phone: form.phone || null, bio: form.bio || null, bio_ur: form.bio_ur || null, name_ur: form.name_ur || null, position_ur: form.position_ur || null,
      admin_user_id: form.admin_user_id || null, proxy_admin_user_id: form.proxy_admin_user_id || null, photo_url: form.photo_url || null,
    }
    if (editing) { const { error } = await supabase.from('committee_members').update(payload).eq('id', editing); if (error) { toast.error(friendlyError(error)); return }; toast.success('Updated') }
    else { const { error } = await supabase.from('committee_members').insert(payload); if (error) { toast.error(friendlyError(error)); return }; toast.success('Added') }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }
  const edit = (m: Member) => {
    setForm({
      name: m.name, name_ur: m.name_ur ?? '', position: m.position, position_ur: m.position_ur ?? '', phone: m.phone ?? '',
      bio: m.bio ?? '', bio_ur: m.bio_ur ?? '', display_order: m.display_order, is_active: m.is_active, photo_url: m.photo_url ?? '',
      admin_user_id: m.admin_user_id ?? '', proxy_admin_user_id: m.proxy_admin_user_id ?? '', uses_smartphone: m.uses_smartphone,
      handles_non_whatsapp_notice: m.handles_non_whatsapp_notice,
    })
    setEditing(m.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm('Remove member?')) return; await supabase.from('committee_members').delete().eq('id', id); toast.success('Removed'); load() }

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Committee Members</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Member</button>
      </div>
      <div className="space-y-4">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
        {!loading && members.map((m) => (
          <div key={m.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex items-center justify-between gap-4 hover:border-dp-secondary transition-all">
            <div className="flex items-center gap-4">
              {m.photo_url ? (
                <Image src={m.photo_url} alt={m.name} width={48} height={48} className="w-12 h-12 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-dp-primary-container text-dp-on-primary-container flex items-center justify-center font-bold font-sans text-[16px] shrink-0">
                  {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="font-sans text-[16px] font-bold text-dp-on-surface">{m.name}</h3>
                <p className="font-sans text-[14px] text-dp-secondary font-semibold">{m.position}</p>
                {m.phone && <p className="font-sans text-[12px] text-dp-on-surface-variant">{m.phone}</p>}
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                  {m.admin_user_id
                    ? `Login: ${adminUserName(m.admin_user_id) ?? 'Unknown'}`
                    : m.proxy_admin_user_id
                      ? `Proxy: ${adminUserName(m.proxy_admin_user_id) ?? 'Unknown'}`
                      : 'No software login or proxy set'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] font-bold font-sans px-2 py-0.5 rounded-full ${m.is_active ? 'bg-dp-secondary-container text-dp-on-secondary-container' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{m.is_active ? 'Active' : 'Inactive'}</span>
              <span className="text-[12px] font-sans text-dp-on-surface-variant">#{m.display_order}</span>
              <button onClick={() => edit(m)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(m.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? 'Edit' : 'Add'} Member</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <ImageUpload bucket="images" label="Photo (optional)" currentUrl={form.photo_url} onUpload={(url) => setForm({ ...form, photo_url: url })} />
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Name (EN)</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Name (UR)</label><input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Position (EN)</label><input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Position (UR)</label><input value={form.position_ur} onChange={(e) => setForm({ ...form, position_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.phone')}</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Bio</label><textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} rows={3} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Bio (UR)</label><textarea value={form.bio_ur} onChange={(e) => setForm({ ...form, bio_ur: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Display Order</label><input type="number" value={form.display_order || ''} onChange={(e) => setForm({ ...form, display_order: +e.target.value })} className="input-field" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">Active Member</span></label>

              <div className="border-t border-dp-outline-variant pt-4 mt-2">
                <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-3">Meetings &amp; Agenda</p>
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input type="checkbox" checked={form.uses_smartphone} onChange={(e) => setForm({ ...form, uses_smartphone: e.target.checked })} className="accent-dp-secondary" />
                  <span className="font-sans text-[14px]">Uses a smartphone (can receive reminders directly)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input type="checkbox" checked={form.handles_non_whatsapp_notice} onChange={(e) => setForm({ ...form, handles_non_whatsapp_notice: e.target.checked })} className="accent-dp-secondary" />
                  <span className="font-sans text-[14px]">Personally informs members without WhatsApp (named in the meeting notice)</span>
                </label>
                <div className="mb-3">
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Software Login (if this member is also a user)</label>
                  <select value={form.admin_user_id} onChange={(e) => setForm({ ...form, admin_user_id: e.target.value })} className="input-field">
                    <option value="">Not linked to a login</option>
                    {adminUsers.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                  </select>
                </div>
                {!form.uses_smartphone && (
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Standing Proxy (receives reminders and marks tasks done on their behalf)</label>
                    <select value={form.proxy_admin_user_id} onChange={(e) => setForm({ ...form, proxy_admin_user_id: e.target.value })} className="input-field">
                      <option value="">No proxy set — falls back to whoever runs the meeting</option>
                      {adminUsers.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? 'Update' : 'Add'} Member</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
