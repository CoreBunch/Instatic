// fallow-ignore-file unused-file
// Loaded at runtime by plugin bundles via the import map in index.html.
// Fallow cannot see this static-asset path; the file is live in production.
/**
 * Plugin-runtime shim for `@instatic/host-ui`.
 *
 * Plugins import named primitives from this package (`Button`, `Stack`,
 * `Card`, `Input`, etc.) — the host's main bundle has already populated
 * `globalThis.__instatic.hostUi` with React component references that
 * use the editor's design system (and only the editor's design system).
 *
 * Adding a new export here: import it on the host side
 * (`src/admin/main.tsx` populates `__instatic.hostUi`), then add the
 * named export below.
 */
const G = globalThis.__instatic?.hostUi
if (!G) {
  throw new Error(
    "[@instatic/runtime] Host UI not initialized. Did the host bundle finish loading before the plugin import?",
  )
}

export const Alert = G.Alert
export const Bars = G.Bars
export const Button = G.Button
export const Card = G.Card
export const Checkbox = G.Checkbox
export const Code = G.Code
export const Delta = G.Delta
export const EmptyState = G.EmptyState
export const Heading = G.Heading
export const Input = G.Input
export const RangeTabs = G.RangeTabs
export const SearchBar = G.SearchBar
export const Select = G.Select
export const Separator = G.Separator
export const Sparkline = G.Sparkline
export const Stack = G.Stack
export const StackedBar = G.StackedBar
export const StatValue = G.StatValue
export const Switch = G.Switch
export const Tab = G.Tab
export const TabList = G.TabList
export const TabPanel = G.TabPanel
export const Tabs = G.Tabs
export const Text = G.Text
export const Textarea = G.Textarea
export const Widget = G.Widget
export const WidgetList = G.WidgetList
export const WidgetListRow = G.WidgetListRow
export const SkeletonBlock = G.SkeletonBlock
export const SkeletonCards = G.SkeletonCards
export const SkeletonRows = G.SkeletonRows
export const SegmentedControl = G.SegmentedControl
export const TagPill = G.TagPill
export const Kbd = G.Kbd
export const ShortcutKeys = G.ShortcutKeys
