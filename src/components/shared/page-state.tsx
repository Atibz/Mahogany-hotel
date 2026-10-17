export function PageLoading() {
  return <p className="py-10 text-sm text-stone-500">Loading…</p>
}

export function PageError({ message }: { message: string }) {
  return <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{message}</p>
}

import type { ReactNode } from 'react'

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-sm text-stone-600">{children}</p>
}
