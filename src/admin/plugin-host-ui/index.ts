/**
 * `@instatic/host-ui` — the named-export host UI surface plugins import.
 *
 *   import { Button, Stack, Card, Text } from '@instatic/host-ui'
 *
 *   export default function MyPanel() {
 *     return <Stack gap={12}><Button variant="primary">Hi</Button></Stack>
 *   }
 *
 * Plugins compile against these named exports as a stable contract. The
 * runtime resolution at editor mount time is handled by the host's import
 * map (see `public/runtime/host-ui.js`) — the plugin's bundle treats this
 * package as an external. That means:
 *
 *   • Plugin bundles never ship the host's design system code.
 *   • The host can refactor its primitives freely; this file's named
 *     exports are the contract.
 *   • One copy of every component runs in the editor: identical theming,
 *     identical accessibility wiring, identical event semantics.
 *
 * The components are the wrappers from `PluginAdminUiComponents.tsx` —
 * already battle-tested by the existing plugin admin pages. Re-exporting
 * them here under stable names is the migration path from the curated
 * `ui` namespace to a proper React component package.
 */
export {
  PluginAlert as Alert,
  PluginButton as Button,
  PluginCard as Card,
  PluginCheckbox as Checkbox,
  PluginCode as Code,
  PluginEmptyState as EmptyState,
  PluginHeading as Heading,
  PluginInput as Input,
  PluginSearchBar as SearchBar,
  PluginSelect as Select,
  PluginSeparator as Separator,
  PluginStack as Stack,
  PluginSwitch as Switch,
  PluginText as Text,
  PluginTextarea as Textarea,
} from '@plugins/components/PluginAdminUi/PluginAdminUiComponents'

/**
 * Chart primitives — Sparkline, Bars, StackedBar, StatValue, Delta.
 *
 * Re-exported here so plugins building dashboard widgets can render the
 * same chart shapes as first-party widgets without bundling their own
 * chart code. Stay achromatic by default; tint colors come from the
 * widget chrome via the standard `--accent-*` tokens.
 */
export {
  Sparkline,
  Bars,
  StackedBar,
  StatValue,
  Delta,
} from '@ui/components/charts'

/**
 * Dashboard widget chrome — Widget, RangeTabs.
 *
 * Re-exported here so plugins that register dashboard widgets via
 * `api.dashboard.widgets.register(...)` get the EXACT same chrome the
 * first-party widgets use: achromatic card surface, tint-dot title row,
 * drag-handle / kebab-menu, customize-mode outline. The widget body owns
 * the content; the chrome handles consistency.
 *
 * `RangeTabs` is the small inline segmented control used inside widget
 * headers (the "24h · 7d · 30d" toggle on Visitors, etc.). Strongly
 * typed on its option value union — pass a string literal type and the
 * tab callbacks are narrowed for you.
 */
export { Widget } from '@ui/components/Widget'
export { RangeTabs } from '@ui/components/RangeTabs'
export { Tabs, TabList, Tab, TabPanel } from '@ui/components/Tabs'
export { WidgetList, WidgetListRow } from '@ui/components/WidgetList'
export {
  SkeletonBlock,
  SkeletonCards,
  SkeletonRows,
} from '@ui/components/Skeleton'
export type { WidgetProps, WidgetTint, WidgetIcon } from '@ui/components/Widget'
export type { RangeTabsProps } from '@ui/components/RangeTabs'
export type { TabsProps, TabListProps, TabProps, TabPanelProps } from '@ui/components/Tabs'
export type { WidgetListProps, WidgetListRowProps } from '@ui/components/WidgetList'
export type {
  SkeletonBlockProps,
  SkeletonCardsProps,
  SkeletonRowsProps,
} from '@ui/components/Skeleton'

export type {
  PluginUiAlertProps as AlertProps,
  PluginUiButtonProps as ButtonProps,
  PluginUiCardProps as CardProps,
  PluginUiCheckboxProps as CheckboxProps,
  PluginUiCodeProps as CodeProps,
  PluginUiEmptyStateProps as EmptyStateProps,
  PluginUiHeadingProps as HeadingProps,
  PluginUiInputProps as InputProps,
  PluginUiSearchBarProps as SearchBarProps,
  PluginUiSelectProps as SelectProps,
  PluginUiSeparatorProps as SeparatorProps,
  PluginUiStackProps as StackProps,
  PluginUiSwitchProps as SwitchProps,
  PluginUiTextProps as TextProps,
  PluginUiTextareaProps as TextareaProps,
} from '@core/plugin-sdk'

export type {
  SparklineProps,
  BarsProps,
  StackedBarProps,
  StackedBarSegment,
  StatValueProps,
  DeltaProps,
} from '@ui/components/charts'
