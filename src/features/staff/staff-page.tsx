import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FunctionsHttpError } from '@supabase/supabase-js'

import { EmptyState, PageError, PageLoading } from '@/components/shared/page-state'
import { Modal } from '@/components/shared/modal'
import { useAuth } from '@/features/auth/auth-provider'
import { useAccess } from '@/features/auth/use-access'
import { useActiveHotel } from '@/features/reception/use-reception'
import { supabase } from '@/lib/supabase/client'
import { inviteFailureMessage } from './invite-error'
import { DEFAULT_PUBLIC_APP_URL, getStaffInviteRedirectUrl } from './invite-redirect'

type Role = { id: string; name: string; code: string }
type StaffMember = { id: string; full_name: string | null; phone: string | null; active: boolean; roles: Role[] }
type RoleChangeTarget = { profile: StaffMember; role: Role }

export function StaffPage() {
  const hotel = useActiveHotel()
  const { session } = useAuth()
  const { roleCodes } = useAccess()
  const queryClient = useQueryClient()
  const [message, setMessage] = useActionMessage<{ text: string; kind: 'pending' | 'success' | 'error' } | null>(null)
  const [inviting, setInviting] = useState(false)
  const inviteInFlight = useRef(false)
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null)
  const [activeChangeTarget, setActiveChangeTarget] = useState<StaffMember | null>(null)
  const [roleChangeTarget, setRoleChangeTarget] = useState<RoleChangeTarget | null>(null)
  const staffQuery = useQuery({
    queryKey: ['staff', hotel.data?.id], enabled: Boolean(hotel.data?.id),
    queryFn: async () => {
      if (!supabase || !hotel.data) throw new Error('Supabase is not configured.')
      const { data: roles, error: roleError } = await supabase.from('roles').select('id, name, code').eq('hotel_id', hotel.data.id).order('name')
      if (roleError) throw new Error(roleError.message)
      const allRoles = (roles ?? []) as Role[]
      const roleList = allRoles.filter((role) => role.code !== 'owner')
      const roleIds = allRoles.map((role) => role.id)
      const { data: assignments, error: assignmentError } = await supabase.from('user_roles').select('profile_id, role_id').in('role_id', roleIds)
      if (assignmentError) throw new Error(assignmentError.message)
      const ownerRoleIds = new Set(allRoles.filter((role) => role.code === 'owner').map((role) => role.id))
      const ownerProfileIds = new Set((assignments ?? []).filter((assignment) => ownerRoleIds.has(assignment.role_id)).map((assignment) => assignment.profile_id))
      const profileIds = [...new Set((assignments ?? []).map((assignment) => assignment.profile_id))].filter((id) => !ownerProfileIds.has(id))
      const { data: profiles, error: profileError } = profileIds.length ? await supabase.from('profiles').select('id, full_name, phone, active').in('id', profileIds) : { data: [], error: null }
      if (profileError) throw new Error(profileError.message)
      const staff: StaffMember[] = (profiles ?? []).map((profile) => {
        const assigned = roleList.filter((role) => (assignments ?? []).some((assignment) => assignment.profile_id === profile.id && assignment.role_id === role.id))
        return { ...profile, roles: assigned.some((role) => role.code === 'managing_director')
          ? assigned.filter((role) => role.code !== 'general_manager') : assigned }
      })
      return { roles: roleList, staff }
    },
  })
  async function refreshStaff() { if (hotel.data) await queryClient.invalidateQueries({ queryKey: ['staff', hotel.data.id] }) }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !hotel.data || inviteInFlight.current) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const email = String(form.get('email')).trim()
    const redirectTo = getStaffInviteRedirectUrl(import.meta.env.VITE_PUBLIC_APP_URL || DEFAULT_PUBLIC_APP_URL)
    if (!redirectTo) {
      setMessage({ text: 'The public invitation link is not configured correctly. Ask an administrator to check VITE_PUBLIC_APP_URL before sending an invite.', kind: 'error' })
      return
    }
    inviteInFlight.current = true
    setInviting(true)
    setMessage({ text: `Sending invitation to ${email}…`, kind: 'pending' })
    try {
      const { error } = await supabase.functions.invoke('invite-staff', { body: { hotelId: hotel.data.id, fullName: String(form.get('name')), email, roleId: String(form.get('roleId')), redirectTo } })
      if (error) {
        let detail = ''
        const response = error instanceof FunctionsHttpError ? error.context : null
        if (response) {
          try {
            const body: unknown = await response.clone().json()
            if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') detail = body.error
          } catch { /* Some platform errors do not have a JSON body. */ }
        }
        setMessage({ text: inviteFailureMessage(response?.status, detail), kind: 'error' })
        return
      }
      formElement.reset()
      setMessage({ text: `Invitation sent to ${email}. The staff member can check their inbox to set a password.`, kind: 'success' })
      await refreshStaff()
    } catch {
      setMessage({ text: inviteFailureMessage(), kind: 'error' })
    } finally {
      inviteInFlight.current = false
      setInviting(false)
    }
  }
  async function replaceRole(profile: StaffMember, role: Role) {
    if (!supabase) return
    setBusyProfileId(profile.id)
    setMessage(null)
    try {
      const { error } = await supabase.rpc('replace_staff_role', { target_profile_id: profile.id, target_role_id: role.id })
      if (error) {
        setMessage({ text: error.message, kind: 'error' })
        return
      }
      await refreshStaff()
      setMessage({ text: `${profile.full_name ?? 'Staff member'}'s role was updated to ${role.name}.`, kind: 'success' })
      setRoleChangeTarget(null)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Staff role could not be updated.', kind: 'error' })
    } finally {
      setBusyProfileId(null)
    }
  }
  async function setActive(profile: StaffMember, active: boolean) {
    if (!supabase) return
    setBusyProfileId(profile.id)
    setMessage(null)
    try {
      const { error } = await supabase.rpc('set_staff_active', { target_profile_id: profile.id, should_be_active: active })
      if (error) {
        setMessage({ text: error.message, kind: 'error' })
        return
      }
      await refreshStaff()
      setMessage({ text: active ? 'Staff access restored.' : 'Staff account deactivated. Their history remains available to management.', kind: 'success' })
      setActiveChangeTarget(null)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Staff access could not be updated.', kind: 'error' })
    } finally {
      setBusyProfileId(null)
    }
  }
  if (hotel.isLoading || staffQuery.isLoading) return <PageLoading />
  if (hotel.error || staffQuery.error) return <PageError message={staffQuery.error instanceof Error ? staffQuery.error.message : 'Unable to load staff access.'} />
  if (!hotel.data || !staffQuery.data) return <EmptyState>No hotel is assigned to your account.</EmptyState>
  const assignableRoles = staffQuery.data.roles.filter((role) => !['owner', 'staff_admin'].includes(role.code) && (role.code !== 'managing_director' || roleCodes.includes('owner')))
  return <section className="max-w-5xl"><p className="text-sm font-medium text-amber-800">Administration</p><h1 className="mt-1 text-3xl font-semibold">Staff & access</h1><p className="mt-2 text-sm text-stone-600">Invite staff, change roles, or deactivate an account. Deactivation removes access but preserves the audit trail.</p>{message && <p className={`mt-4 rounded-lg border p-3 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : message.kind === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-950'}`} role="status" aria-live="polite">{message.text}</p>}
    <form onSubmit={invite} className="mt-6 grid gap-3 rounded-xl border bg-white p-5 md:grid-cols-4"><input required name="name" placeholder="Staff name" className="rounded-lg border px-3 py-2.5" /><input required name="email" type="email" placeholder="Email address" className="rounded-lg border px-3 py-2.5" /><select required name="roleId" className="rounded-lg border px-3 py-2.5"><option value="">Role</option>{assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><FormSubmitButton type="submit" disabled={inviting} aria-busy={inviting} className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60">{inviting ? 'Sending invite…' : 'Invite staff'}</FormSubmitButton></form>
    <div className="mt-6 overflow-hidden rounded-xl border bg-white">{staffQuery.data.staff.map((profile) => { const currentRole = profile.roles[0]; const isSelf = profile.id === session?.user.id; const isOwner = profile.roles.some((role) => role.code === 'owner'); const isManagingDirector = profile.roles.some((role) => role.code === 'managing_director'); const protectedRole = (isOwner || isManagingDirector) && !roleCodes.includes('owner'); const disabled = busyProfileId === profile.id || isSelf || protectedRole; return <div key={profile.id} className="grid gap-3 border-b p-4 md:grid-cols-[1fr_12rem_auto] md:items-center"><span><b>{profile.full_name || 'Unnamed staff'}</b><span className="ml-2 text-sm text-stone-500">{profile.active ? 'Active' : 'Inactive'}</span><small className="mt-1 block text-stone-500">{profile.roles.map((role) => role.name).join(', ') || 'No role'}</small></span><select aria-label={`Role for ${profile.full_name ?? 'staff member'}`} value={currentRole?.id ?? ''} disabled={disabled} onChange={(event) => { const selectedRole = assignableRoles.find((role) => role.id === event.target.value); if (selectedRole && selectedRole.id !== currentRole?.id) setRoleChangeTarget({ profile, role: selectedRole }) }} className="rounded-lg border px-3 py-2.5 text-sm disabled:bg-stone-100"><option value="">Select role</option>{profile.roles.filter((role) => !assignableRoles.some((candidate) => candidate.id === role.id)).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}{assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><button type="button" disabled={disabled} onClick={() => setActiveChangeTarget(profile)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 disabled:cursor-not-allowed disabled:opacity-50">{profile.active ? 'Deactivate' : 'Restore access'}</button>{isSelf && <small className="text-xs text-stone-500 md:col-span-3">You cannot change your own access here.</small>}{protectedRole && !isSelf && <small className="text-xs text-stone-500 md:col-span-3">Only the hotel owner can change this account.</small>}</div> })}</div>
    <Modal open={Boolean(activeChangeTarget)} title={activeChangeTarget?.active ? 'Deactivate staff access?' : 'Restore staff access?'} onClose={() => { if (busyProfileId === activeChangeTarget?.id) return; setActiveChangeTarget(null) }}>
      {activeChangeTarget && <div className="space-y-4">
        <p className="text-sm leading-6 text-stone-600">{activeChangeTarget.active ? <>This will block <strong>{activeChangeTarget.full_name || 'this staff member'}</strong> from signing in to the hotel app. Their financial and operational history will remain available to management.</> : <>This will restore <strong>{activeChangeTarget.full_name || 'this staff member'}</strong>'s access using their existing role.</>}</p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busyProfileId === activeChangeTarget.id} onClick={() => setActiveChangeTarget(null)} className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 disabled:opacity-60">Cancel</button>
          <button type="button" disabled={busyProfileId === activeChangeTarget.id} onClick={() => void setActive(activeChangeTarget, !activeChangeTarget.active)} className={`rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 ${activeChangeTarget.active ? 'bg-rose-700 hover:bg-rose-800' : 'bg-amber-900 hover:bg-amber-950'}`}>
            {busyProfileId === activeChangeTarget.id ? 'Saving…' : activeChangeTarget.active ? 'Deactivate access' : 'Restore access'}
          </button>
        </div>
      </div>}
    </Modal>
    <Modal open={Boolean(roleChangeTarget)} title="Confirm staff role change" onClose={() => { if (busyProfileId === roleChangeTarget?.profile.id) return; setRoleChangeTarget(null) }}>
      {roleChangeTarget && <div className="space-y-4">
        <p className="text-sm leading-6 text-stone-600"><strong>{roleChangeTarget.profile.full_name || 'This staff member'}</strong>'s access will change from <strong>{roleChangeTarget.profile.roles.map((role) => role.name).join(', ') || 'No role'}</strong> to <strong>{roleChangeTarget.role.name}</strong>. The change takes effect immediately and is recorded in the hotel audit history.</p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busyProfileId === roleChangeTarget.profile.id} onClick={() => setRoleChangeTarget(null)} className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 disabled:opacity-60">Cancel</button>
          <button type="button" disabled={busyProfileId === roleChangeTarget.profile.id} onClick={() => void replaceRole(roleChangeTarget.profile, roleChangeTarget.role)} className="rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60">
            {busyProfileId === roleChangeTarget.profile.id ? 'Saving…' : 'Confirm role change'}
          </button>
        </div>
      </div>}
    </Modal>
  </section>
}
