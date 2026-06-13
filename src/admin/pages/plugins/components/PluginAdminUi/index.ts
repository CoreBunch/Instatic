/**
 * Host-internal UI namespace — bundles the existing `Plugin*` wrappers as
 * one record for the host's own form-rendering code (e.g. the Plugin
 * Settings dialog uses `pluginAdminUi.Switch` etc.).
 *
 * Plugin code no longer reaches into this namespace — plugins import the
 * named primitives directly from `@instatic/host-ui` (resolved via
 * the host's import map at runtime). This file is internal host plumbing.
 */
import type { ComponentType } from 'react'
import type {
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
} from '@core/plugin-sdk'
import {
  PluginAlert,
  PluginButton,
  PluginCard,
  PluginCheckbox,
  PluginCode,
  PluginEmptyState,
  PluginHeading,
  PluginInput,
  PluginSearchBar,
  PluginSelect,
  PluginSeparator,
  PluginStack,
  PluginSwitch,
  PluginText,
  PluginTextarea,
} from './PluginAdminUiComponents'

interface PluginAdminUiNamespace {
  Button: ComponentType<PluginUiButtonProps>
  Input: ComponentType<PluginUiInputProps>
  Textarea: ComponentType<PluginUiTextareaProps>
  Select: ComponentType<PluginUiSelectProps>
  Switch: ComponentType<PluginUiSwitchProps>
  Checkbox: ComponentType<PluginUiCheckboxProps>
  SearchBar: ComponentType<PluginUiSearchBarProps>
  Stack: ComponentType<PluginUiStackProps>
  Card: ComponentType<PluginUiCardProps>
  Heading: ComponentType<PluginUiHeadingProps>
  Text: ComponentType<PluginUiTextProps>
  Separator: ComponentType<PluginUiSeparatorProps>
  EmptyState: ComponentType<PluginUiEmptyStateProps>
  Alert: ComponentType<PluginUiAlertProps>
  Code: ComponentType<PluginUiCodeProps>
}

export const pluginAdminUi: PluginAdminUiNamespace = {
  Button: PluginButton,
  Input: PluginInput,
  Textarea: PluginTextarea,
  Select: PluginSelect,
  Switch: PluginSwitch,
  Checkbox: PluginCheckbox,
  SearchBar: PluginSearchBar,
  Stack: PluginStack,
  Card: PluginCard,
  Heading: PluginHeading,
  Text: PluginText,
  Separator: PluginSeparator,
  EmptyState: PluginEmptyState,
  Alert: PluginAlert,
  Code: PluginCode,
}
