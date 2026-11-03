import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type PropsWithChildren } from 'react'

import { AuthProvider } from '@/features/auth/auth-provider'
import { ActionFeedbackProvider } from '@/components/shared/action-feedback'

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <ActionFeedbackProvider>
        <AuthProvider>{children}</AuthProvider>
      </ActionFeedbackProvider>
    </QueryClientProvider>
  )
}
