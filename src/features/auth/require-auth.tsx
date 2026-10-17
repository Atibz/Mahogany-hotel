import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '@/features/auth/auth-provider'
import { isSupabaseConfigured } from '@/lib/supabase/client'

export function RequireAuth() {
  const { session, isLoading, isActiveStaff } = useAuth()

  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />

  if (isLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-100 p-5 text-sm text-stone-600">
        Restoring your session…
      </main>
    )
  }

  if (!session) return <Navigate to="/sign-in" replace />
  if (!isActiveStaff) return <Navigate to="/account-unavailable" replace />
  return <Outlet />
}
