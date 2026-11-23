/**
 * `definePluginPanel` — type-safe plugin editor panel entrypoint.
 *
 *   import { definePluginPanel } from '@instatic/plugin-sdk'
 *   import { Stack, Button, Card, Text } from '@instatic/host-ui'
 *   import { useState } from 'react'
 *
 *   function ReviewPanel() {
 *     const [count, setCount] = useState(0)
 *     return (
 *       <Stack gap={12}>
 *         <Text variant="muted">Demo panel registered via editor.panels.</Text>
 *         <Card>
 *           <Stack gap={8}>
 *             <Text>Click count: {count}</Text>
 *             <Button variant="primary" onClick={() => setCount(count + 1)}>
 *               Increment
 *             </Button>
 *           </Stack>
 *         </Card>
 *       </Stack>
 *     )
 *   }
 *
 *   export default definePluginPanel({
 *     id: 'acme.workflow.review',
 *     label: 'Review',
 *     iconName: 'box-stack',
 *     component: ReviewPanel,
 *   })
 *
 * The plugin's bundle has zero React imports relative to the runtime — at
 * build time, `instatic-plugin build` externalizes `react`, `react/jsx-runtime`,
 * `@instatic/host-ui`, `@instatic/host-hooks`, and
 * `@instatic/plugin-sdk`. The host's import map resolves those names at
 * mount time to its own React instance and design-system primitives, so
 * plugins share host React + host UI without bundling a copy.
 *
 * The host owns the panel chrome (title + close button via `PanelHeader`).
 * Your component renders only the panel BODY — title and close are
 * injected automatically.
 */

import type { ComponentType } from 'react'
import type {
  PluginEditorPanel,
  PluginEditorPanelAccent,
} from '../types'

/**
 * Props passed to a plugin editor panel's React component on each render.
 * Carries the panel's identity so plugin code can branch on which surface
 * it's currently rendering for.
 */
export interface PluginEditorPanelProps {
  panel: { id: string; pluginId: string; label: string }
}

export type PluginEditorPanelComponent = ComponentType<PluginEditorPanelProps>

export interface DefinePluginEditorPanelConfig {
  id: string
  label: string
  iconName: string
  accent?: PluginEditorPanelAccent
  shortcutLabel?: string
  /**
   * React component rendered into the panel body. The host's `PanelHeader`
   * already renders the title + close button — this component renders the
   * body only.
   */
  component: PluginEditorPanelComponent
}

const PANEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

/**
 * Identity wrapper — validates the id shape at definition time so authoring
 * errors surface during `instatic-plugin build`, not at editor activation.
 */
export function definePluginPanel(
  config: DefinePluginEditorPanelConfig,
): PluginEditorPanel {
  if (!PANEL_ID_PATTERN.test(config.id)) {
    throw new Error(
      `[plugin-sdk] Editor panel id "${config.id}" must be a lowercase dotted/dashed identifier (e.g. "acme.workflow.review").`,
    )
  }
  if (!config.id.includes('.')) {
    throw new Error(
      `[plugin-sdk] Editor panel id "${config.id}" must be namespaced under the plugin id (e.g. "acme.workflow.review").`,
    )
  }
  if (!config.iconName.trim()) {
    throw new Error(`[plugin-sdk] Editor panel "${config.id}" requires a non-empty iconName.`)
  }
  return {
    id: config.id,
    label: config.label,
    iconName: config.iconName,
    accent: config.accent,
    shortcutLabel: config.shortcutLabel,
    component: config.component,
  }
}
