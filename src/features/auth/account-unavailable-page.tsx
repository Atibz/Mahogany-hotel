import { LogOut, ShieldAlert } from 'lucide-react'
import { useActionMessage } from '@/components/shared/action-feedback'

import { supabase } from '@/lib/supabase/client'

export function AccountUnavailablePage() {
  const [, setSignOutError] = useActionMessage<string | null>(null, 'error')
  async function handleSignOut() {
    if (!supabase) {
      setSignOutError('Sign out is unavailable. Please try again shortly.')
      return
    }
    try {
      const { error } = await supabase.auth.signOut()
      if (error) setSignOutError(`Could not sign out: ${error.message}`)
    } catch (error) {
      setSignOutError(error instanceof Error ? `Could not sign out: ${error.message}` : 'Could not sign out. Please try again.')
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-5">
      <section className="w-full max-w-xl rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <ShieldAlert className="size-7 text-amber-800" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-stone-950">Your account is unavailable</h1>
        <p className="mt-3 leading-7 text-stone-600">
          Your staff account has not been activated or has been disabled. Contact an authorised hotel administrator for access.
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-700"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </button>
      </section>
    </main>
  )
}
