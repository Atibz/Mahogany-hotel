import { Navigate } from 'react-router-dom'
import { Settings2 } from 'lucide-react'

import { isSupabaseConfigured } from '@/lib/supabase/client'

export function SetupPage() {
  if (isSupabaseConfigured) return <Navigate to="/sign-in" replace />

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-5">
      <section className="w-full max-w-xl rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <Settings2 className="size-6 text-amber-800" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-stone-950">Supabase connection required</h1>
        <p className="mt-3 leading-7 text-stone-600">
          Add <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">VITE_SUPABASE_URL</code> and{' '}
          <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">VITE_SUPABASE_PUBLISHABLE_KEY</code> to a local{' '}
          <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">.env</code> or{' '}
          <code className="rounded bg-stone-100 px-1.5 py-0.5 text-sm">.env.local</code> file, then restart the dev server.
          Only the public publishable key belongs in the browser.
        </p>
      </section>
    </main>
  )
}
