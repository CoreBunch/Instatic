import { lazy } from 'react'

export const FloatingPanel = lazy(() => import('./FloatingPanel'))
export const ColorPickerPanel = lazy(() => import('./FloatingPanel').then((m) => ({ default: m.ColorPickerPanel })))
