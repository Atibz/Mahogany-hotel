import type { PropsWithChildren } from 'react'

import { PageLoading } from '@/components/shared/page-state'
import type { Feature } from '@/features/auth/access-policy'
import { useAccess } from '@/features/auth/use-access'

export function AccessDeniedPage() {
  return <section className="mx-auto max-w-lg rounded-xl border border-amber-200 bg-amber-50 p-6"><p className="text-sm font-medium text-amber-800">Access restricted</p><h1 className="mt-1 text-2xl font-semibold">This area is not assigned to your role.</h1><p className="mt-3 text-sm leading-6 text-stone-700">Ask the Owner or General Manager if you need access to this part of the system.</p></section>
}

export function RequireFeature({ feature, children }: PropsWithChildren<{ feature: Feature }>) {
  const { isLoading, canAccess } = useAccess()
  if (isLoading) return <PageLoading />
  return canAccess(feature) ? <>{children}</> : <AccessDeniedPage />
}
