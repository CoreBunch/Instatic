import { useEffect, useRef } from 'react'
import { useMobileViewport } from '@admin/lib/mobileViewport'

export function useModuleInserterViewport() {
  const phone = useMobileViewport()
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!phone) return
    closeRef.current?.focus({ preventScroll: true })
    // The virtual keyboard can shrink the visual viewport independently of dvh.
    const viewport = window.visualViewport
    const backdrop = backdropRef.current
    if (!viewport || !backdrop) return
    const fitViewport = () => {
      backdrop.style.setProperty('--picker-height', `${viewport.height}px`)
      backdrop.style.setProperty('--picker-top', `${viewport.offsetTop}px`)
    }
    fitViewport()
    viewport.addEventListener('resize', fitViewport)
    viewport.addEventListener('scroll', fitViewport)
    return () => {
      viewport.removeEventListener('resize', fitViewport)
      viewport.removeEventListener('scroll', fitViewport)
    }
  }, [phone])

  return { phone, backdropRef, closeRef }
}
