/**
 * Plugin panel icon registry — maps `iconName` strings declared by plugins
 * via `definePluginPanel({ iconName })` to actual `pixel-art-icons` React
 * components.
 *
 * The registry is intentionally curated: plugins can't reach into arbitrary
 * icon files at runtime (no dynamic import, no string-to-module shims), so
 * the rail's bundle stays tree-shakeable and the surface area authors
 * compile against is explicit. Unknown names fall back to `BoxSolidIcon`.
 *
 * Adding a new icon: import it here and add a record entry. That's it.
 *
 * The list intentionally covers the high-frequency "sidebar panel" verbs —
 * extension / inspector / settings / data / docs — without bloating the
 * editor bundle with the entire 4k-icon catalog.
 */
import type { IconComponent } from 'pixel-art-icons/types'
import { BookOpenSolidIcon } from 'pixel-art-icons/icons/book-open-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { Bulletlist2SharpIcon } from 'pixel-art-icons/icons/bulletlist-2-sharp'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { FilesStack2SolidIcon } from 'pixel-art-icons/icons/files-stack-2-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'

/**
 * Icon name → component lookup. Names use the kebab-case file convention
 * from the `pixel-art-icons` package so plugin authors can copy them
 * directly from the icon catalog.
 */
const PLUGIN_PANEL_ICONS: Record<string, IconComponent> = {
  'book-open-solid': BookOpenSolidIcon,
  'box': BoxSolidIcon,
  'box-stack': BoxStackSolidIcon,
  'circle-alert': CircleAlertSolidIcon,
  'ai-settings-solid': AiSettingsSolidIcon,
  'bulletlist-2-sharp': Bulletlist2SharpIcon,
  'colors-swatch': ColorsSwatchSolidIcon,
  'files-stack-2': FilesStack2SolidIcon,
  'images': ImagesSolidIcon,
  'paint-bucket': PaintBucketSolidIcon,
  'ruler-dimension': RulerDimensionSolidIcon,
  'text-start-t': TextStartTIcon,
}

/**
 * Resolve a plugin-declared icon name to a `pixel-art-icons` component.
 * Falls back to `BoxSolidIcon` for any name not in the registry — keeps the
 * rail visually stable even when a plugin ships an icon name we haven't
 * imported yet.
 */
export function resolvePluginPanelIcon(name: string): IconComponent {
  return PLUGIN_PANEL_ICONS[name] ?? BoxSolidIcon
}
