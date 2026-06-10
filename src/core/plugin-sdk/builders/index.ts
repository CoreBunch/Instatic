/**
 * Plugin SDK builder surface — author-facing API.
 *
 * Re-exports every builder so plugin authors can pull what they need from
 * a single import path:
 *
 *   import {
 *     definePlugin, defineModule, defineComponent, definePack,
 *     definePluginAdminApp, definePluginPanel,
 *     control, html, raw, safeUrl,
 *     permissions, createNamespace, h, vc,
 *   } from '@instatic/plugin-sdk'
 *
 * The host re-exports this surface from `@core/plugin-sdk` so first-party
 * plugins (in this monorepo) can use the same API without an extra
 * dependency.
 */

export { definePlugin } from './definePlugin'
export type { DefinePluginConfig, PluginDefinition } from './definePlugin'
export {
  pluginSettingsDefaults,
  validatePluginSettingsRecord,
  validatePluginSettingsDefinitions,
  SECRET_SETTING_MASK,
} from './settings'
export type {
  PluginSettingDefinition,
  PluginSettingValue,
  PluginSettingsValues,
} from './settings'
export { defineModule } from './defineModule'
export { defineComponent, vc, h } from './tree'
export { definePack } from './definePack'
export type { PluginPackContents } from './definePack'
export { control } from './controls'
export { html, raw, safeUrl, escapeHtml } from './html'
export { permissions } from './permissions'
export type { PermissionAlias } from './permissions'
export { createNamespace } from './namespace'
export type { PluginNamespace } from './namespace'
export { definePluginAdminApp } from './adminApp'
export type {
  PluginAdminAppComponent,
  PluginAdminAppProps,
  PluginUiAlertProps,
  PluginUiButtonProps,
  PluginUiCardProps,
  PluginUiCheckboxProps,
  PluginUiCodeProps,
  PluginUiEmptyStateProps,
  PluginUiHeadingProps,
  PluginUiInputProps,
  PluginUiSearchBarProps,
  PluginUiSelectProps,
  PluginUiSeparatorProps,
  PluginUiStackProps,
  PluginUiSwitchProps,
  PluginUiTextProps,
  PluginUiTextareaProps,
} from './adminApp'
export { definePluginPanel } from './panel'
export type {
  DefinePluginEditorPanelConfig,
  PluginEditorPanelComponent,
  PluginEditorPanelProps,
} from './panel'
export { definePluginCanvasOverlay } from './canvasOverlay'
export type {
  DefinePluginCanvasOverlayConfig,
  PluginCanvasOverlayComponent,
  PluginCanvasOverlayProps,
} from './canvasOverlay'
