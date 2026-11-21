import { useLocation } from '@admin/lib/routing'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'

/**
 * Soft navigation between admin sections. Runs the caller's
 * `onNavigateStart` hook first (the editor uses it to settle in-flight work),
 * and is a no-op for the page the user is already on.
 *
 * Always used inside the admin Router (the admin shell unconditionally mounts
 * one), so there is no router-vs-static fork here.
 */
export function useAdminRouteNavigation(onNavigateStart?: () => unknown): (to: string) => void {
  const navigate = useAdminNavigate()
  const location = useLocation()

  return (to) => {
    if (location.pathname === to) return
    void (async () => {
      try {
        const result = onNavigateStart?.()
        if (isPromiseLike(result)) await result
        navigate(to)
      } catch (err) {
        console.error('[AdminSectionNavigation] Navigation start hook failed:', err)
      }
    })()
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (!('then' in value)) return false
  return typeof (value as { then: unknown }).then === 'function'
}
