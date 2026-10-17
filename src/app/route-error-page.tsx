import { isRouteErrorResponse, useRouteError } from 'react-router-dom'

export function RouteErrorPage() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error) ? error.statusText : 'Something went wrong while loading this page.'
  return <main className="grid min-h-screen place-items-center bg-stone-50 p-6"><section className="max-w-md rounded-xl border border-stone-200 bg-white p-6 text-center shadow-sm"><p className="text-sm font-medium text-amber-800">Mahogany Hotel</p><h1 className="mt-2 text-2xl font-semibold">Page unavailable</h1><p className="mt-3 text-sm text-stone-600">{message}</p><button type="button" onClick={() => window.location.assign('/')} className="mt-5 rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white">Return to dashboard</button></section></main>
}
