import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { isSupabaseConfigured, supabase } from '@/lib/supabase/client'

type PasswordFlow = 'invite' | 'recovery'

export function SetPasswordPage() {
  const navigate = useNavigate()
  const [flow] = useState<PasswordFlow | null>(() => {
    const requestedFlow = new URLSearchParams(window.location.search).get('flow')
    return requestedFlow === 'invite' || requestedFlow === 'recovery' ? requestedFlow : null
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState<string | null>(() => flow ? null : 'This account link is invalid. Request a fresh link from the sign-in page or ask your manager to resend the invitation.')
  const [isCheckingLink, setIsCheckingLink] = useState(Boolean(flow && supabase))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)

  useEffect(() => {
    if (!flow || !supabase) return

    let isCurrent = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!isCurrent) return
      setIsCheckingLink(false)
      const sessionEmail = data.session?.user.email?.trim().toLowerCase()
      if (error || !sessionEmail) {
        setMessage(flow === 'recovery'
          ? 'This password-reset link is invalid or has expired. Request a new one from the sign-in page.'
          : 'This invitation link is invalid or has expired. Ask your manager to send a new invitation.')
        return
      }
      setEmail(sessionEmail)
    })
    return () => { isCurrent = false }
  }, [flow])

  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    if (!supabase || !normalizedEmail || isSubmitting) return
    if (password.length < 8) return setMessage('Use a password of at least 8 characters.')
    if (password !== confirmation) return setMessage('The passwords do not match.')

    setIsSubmitting(true)
    setMessage(null)
    const { data: current, error: sessionError } = await supabase.auth.getSession()
    const currentEmail = current.session?.user.email?.trim().toLowerCase()
    if (sessionError || currentEmail !== normalizedEmail) {
      setIsSubmitting(false)
      setEmail('')
      setMessage('The account session is no longer valid. Request a fresh email link and try again.')
      return
    }

    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setIsSubmitting(false)
      setMessage(error.message)
      return
    }

    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
    setIsSubmitting(false)
    if (signOutError) {
      setMessage('Your password was saved, but we could not sign you out. Please sign out and then sign in with your new password.')
      return
    }
    navigate('/sign-in?password=updated', { replace: true })
  }

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-5">
      <section className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <img src="/mahogany-logo.png" alt="Mahogany Hotel & Suites" className="h-20 w-64 max-w-full object-contain" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          {flow === 'invite' ? 'Activate your staff account' : 'Reset your password'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          {flow === 'invite'
            ? 'Your secure invitation link lets you choose a password for your staff account.'
            : 'Your secure email link lets you choose a new password.'}
        </p>

        {isCheckingLink ? (
          <p className="mt-6 text-sm text-stone-600" role="status">Verifying your secure link…</p>
        ) : email ? (
          <form onSubmit={savePassword} className="mt-6">
            <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
              Link verified for <span className="font-semibold">{email}</span>
            </p>
            <label htmlFor="new-password" className="block text-sm font-medium text-stone-700">New password</label>
            <div className="relative mt-2" dir="ltr">
              <input id="new-password" required minLength={8} type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-lg border border-stone-300 py-2.5 pl-3 pr-14 text-left outline-none transition focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200" />
              <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)} style={{ left: 'auto', right: '0.5rem' }} className="absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-stone-600 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700">
                {showPassword ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
              </button>
            </div>

            <label htmlFor="confirm-password" className="mt-4 block text-sm font-medium text-stone-700">Confirm password</label>
            <div className="relative mt-2" dir="ltr">
              <input id="confirm-password" required minLength={8} type={showConfirmation ? 'text' : 'password'} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded-lg border border-stone-300 py-2.5 pl-3 pr-14 text-left outline-none transition focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200" />
              <button type="button" aria-label={showConfirmation ? 'Hide password' : 'Show password'} aria-pressed={showConfirmation} onClick={() => setShowConfirmation((visible) => !visible)} style={{ left: 'auto', right: '0.5rem' }} className="absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-stone-600 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700">
                {showConfirmation ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
              </button>
            </div>
            {message && <p className="mt-4 text-sm text-red-700" role="alert">{message}</p>}
            <button disabled={isSubmitting} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 disabled:opacity-70">
              {isSubmitting && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
              {isSubmitting ? 'Saving password…' : 'Save password'}
            </button>
          </form>
        ) : (
          <p className="mt-6 text-sm text-red-700" role="alert">{message}</p>
        )}
        <Link className="mt-5 inline-block text-sm font-semibold text-amber-900" to="/sign-in">Back to sign in</Link>
      </section>
    </main>
  )
}
