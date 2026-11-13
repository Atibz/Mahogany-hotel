import { FormSubmitButton } from "@/components/shared/form-submit-button";
import { useActionMessage } from "@/components/shared/action-feedback";
import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Modal } from '@/components/shared/modal'
import { useAccess } from '@/features/auth/use-access'
import { useAuth } from '@/features/auth/auth-provider'
import { useActiveHotel } from '@/features/reception/use-reception'
import { supabase } from '@/lib/supabase/client'

const roleLabels: Record<string, string> = { owner: 'Owner', managing_director: 'Managing Director', general_manager: 'General Manager', receptionist: 'Receptionist', cashier: 'Cashier', restaurant_staff: 'Restaurant staff', bar_staff: 'Bar staff', storekeeper: 'Storekeeper', accountant: 'Accountant', staff_admin: 'Staff administrator' }

export function ProfilePage() {
  const navigate = useNavigate()
  const { session } = useAuth(); const hotel = useActiveHotel(); const { roleCodes, isLoading: isAccessLoading } = useAccess()
  const [isPasswordOpen, setIsPasswordOpen] = useState(false); const [oldPassword, setOldPassword] = useState(''); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [message, setMessage] = useActionMessage<string | null>(null); const [isSubmitting, setIsSubmitting] = useState(false)
  const fullName = typeof session?.user.user_metadata.full_name === 'string' ? session.user.user_metadata.full_name : 'Staff member'
  function closePasswordDialog() { if (isSubmitting) return; setIsPasswordOpen(false); setOldPassword(''); setPassword(''); setConfirmation(''); setMessage(null) }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !session?.user.email) return
    if (password.length < 8) return setMessage('Use a new password of at least 8 characters.')
    if (password !== confirmation) return setMessage('The new passwords do not match.')
    setMessage(null); setIsSubmitting(true)
    const { error: verificationError } = await supabase.auth.signInWithPassword({ email: session.user.email, password: oldPassword })
    if (verificationError) { setIsSubmitting(false); setMessage('Your current password is incorrect.'); return }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) { setIsSubmitting(false); setMessage(error.message); return }
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
    setIsSubmitting(false)
    if (signOutError) { setMessage('Your password was saved, but we could not sign you out. Please sign out and then sign in with your new password.'); return }
    navigate('/sign-in?password=updated', { replace: true })
  }
  return <section className="mx-auto max-w-2xl"><p className="text-sm font-medium text-amber-800">My account</p><h1 className="mt-1 text-3xl font-semibold">Profile & security</h1><p className="mt-2 text-sm text-stone-600">Your account details and access level at Mahogany Hotel.</p>
    <section className="mt-6 rounded-xl border bg-white p-5"><div className="flex items-start gap-3"><div className="grid size-10 place-items-center rounded-full bg-amber-100 text-amber-900"><ShieldCheck className="size-5" /></div><div><h2 className="font-semibold">{fullName}</h2><p className="text-sm text-stone-600">{session?.user.email}</p></div></div><dl className="mt-6 grid gap-5 border-t pt-5 sm:grid-cols-2"><div><dt className="text-sm text-stone-500">Assigned role</dt><dd className="mt-1 font-medium">{isAccessLoading ? 'Loading role…' : roleCodes.filter((role) => role !== 'general_manager' || !roleCodes.includes('managing_director')).map((role) => roleLabels[role] ?? role).join(', ') || 'No active role assigned'}</dd></div><div><dt className="text-sm text-stone-500">Hotel</dt><dd className="mt-1 font-medium">{hotel.isLoading ? 'Loading…' : hotel.error ? 'Unable to load hotel' : hotel.data?.trading_name ?? 'No hotel assigned'}</dd></div></dl></section>
    <section className="mt-5 rounded-xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Password</h2><p className="mt-1 text-sm text-stone-600">Keep your staff account secure with a password known only to you.</p></div><button type="button" onClick={() => setIsPasswordOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-800 hover:bg-stone-50"><KeyRound className="size-4" />Change password</button></div></section>
    <Modal open={isPasswordOpen} title="Change your password" onClose={closePasswordDialog}><form onSubmit={changePassword} className="space-y-4"><p className="text-sm leading-6 text-stone-600">For your protection, confirm your current password before choosing a new one.</p><label className="block text-sm font-medium">Current password<input required type="password" autoComplete="current-password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100" /></label><label className="block text-sm font-medium">New password<input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100" /></label><label className="block text-sm font-medium">Confirm new password<input required minLength={8} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-100" /></label>{message && <p className="text-sm text-red-700" role="alert">{message}</p>}<div className="flex justify-end gap-2 pt-2"><button type="button" onClick={closePasswordDialog} disabled={isSubmitting} className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold">Cancel</button><FormSubmitButton disabled={isSubmitting || password !== confirmation} className="inline-flex items-center gap-2 rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:opacity-70">{isSubmitting && <LoaderCircle className="size-4 animate-spin" />}Save new password</FormSubmitButton></div></form></Modal>
  </section>
}
