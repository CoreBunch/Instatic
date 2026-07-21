/**
 * ModuleIcon — single source of truth for rendering a module's icon.
 *
 * Every module declaration sets `icon: IconComponent` (see
 * `ModuleDefinition` in `@core/module-engine/types`). This component looks
 * up the module by id from the global registry and renders the icon, so
 * every place in the editor that shows a module — the layer tree, the
 * canvas notch, the Properties Panel "Module settings" header, the module
 * picker popover — uses the same icon for the same module without
 * duplicated mapping tables.
 *
 * Pass either `moduleId` (preferred — handles unknown ids gracefully) or
 * `module` directly when the caller already has the resolved definition.
 */
import type { AnyModuleDefinition } from '@core/module-engine'
import type { IconProps } from 'pixel-art-icons/types'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { useModuleDefinition } from '@site/useModuleRegistry'

interface ModuleIconProps extends IconProps {
  /** Module id to resolve from the registry. Ignored when `module` is set. */
  moduleId?: string
  /** Already-resolved module definition. */
  module?: AnyModuleDefinition | null
}

export function ModuleIcon({
  moduleId,
  module: explicitModule,
  ...iconProps
}: ModuleIconProps) {
  // Registry-reactive lookup — see `useModuleRegistry.ts` for why this must
  // come out of the hook's snapshot rather than a raw `registry.get()`.
  const fromRegistry = useModuleDefinition(explicitModule ? undefined : moduleId)
  const definition = explicitModule ?? fromRegistry ?? null
  const ResolvedIcon = definition?.icon ?? SquareSolidIcon
  return <ResolvedIcon {...iconProps} />
}
