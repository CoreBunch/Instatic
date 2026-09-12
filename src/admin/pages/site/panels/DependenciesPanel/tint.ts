/** Identity accent for a package or a fixed rail accent, as the `--tint` custom property tiles read. */
import type { CSSProperties } from 'react'
import { railAccent, railTintVar, type RailAccent } from '@ui/railAccent'

export function tintStyle(identity: string): CSSProperties {
  return { '--tint': railTintVar(railAccent(identity)) } as CSSProperties
}

export function accentStyle(accent: RailAccent): CSSProperties {
  return { '--tint': railTintVar(accent) } as CSSProperties
}
