import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react'
import type { Session } from '@supabase/supabase-js'

import { supabase } from '@/lib/supabase/client'

type AuthState = {
  session: Session | null
  isLoading: boolean
  isActiveStaff: boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AuthState>({
    session: null,
    isLoading: Boolean(supabase),
    isActiveStaff: false,
  })

  useEffect(() => {
    if (!supabase) return undefined

    let isMounted = true
    let authRevision = 0

    async function hydrateSession(session: Session | null) {
      const revision = ++authRevision
      if (!session) {
        if (isMounted && revision === authRevision) {
          setState({ session: null, isLoading: false, isActiveStaff: false })
        }
        return
      }

      const { data } = await supabase
        .from('profiles')
        .select('active')
        .eq('id', session.user.id)
        .maybeSingle()

      // A previous session lookup can finish after a later sign-out. Ignore
      // that stale result so it cannot restore authenticated UI.
      if (isMounted && revision === authRevision) {
        setState({ session, isLoading: false, isActiveStaff: data?.active === true })
      }
    }

    void supabase.auth.getSession().then(({ data }) => hydrateSession(data.session))

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      void hydrateSession(session)
    })

    return () => {
      isMounted = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

// This hook intentionally shares the provider's context with route guards.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider.')
  return context
}
