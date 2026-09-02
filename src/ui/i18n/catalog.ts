/** Primitive-owned defaults. Hosts can replace copy without a UI → app dependency. */
export const englishUiMessages = {
  selectOption: 'Select option',
  noMatches: 'No matches',
  search: 'Search…',
  clearSearch: 'Clear search',
  clearItem: 'Clear {label}',
  removeItem: 'Remove {label}',
  close: 'Close',
  closeDialog: 'Close dialog',
  moreActions: 'More actions',
  notifications: 'Notifications',
  dismissNotification: 'Dismiss notification',
  increase: 'Increase',
  decrease: 'Decrease',
  loadingWidget: 'Loading widget',
  widgetOptions: '{title} options',
  renderFailed: 'Render failed in {location}',
  copyDetails: 'Copy details',
  loadFailed: 'This part of the page failed to load.',
  retryHelp: "We've logged the error. You can try again, or refresh the page.",
  componentStack: 'Component stack',
  reset: 'Reset',
}

export type UiMessageKey = keyof typeof englishUiMessages
export type UiMessageCatalog = Record<UiMessageKey, string>
export type UiMessageParams = Record<string, string | number>

export function formatUiMessage(
  catalog: UiMessageCatalog,
  key: UiMessageKey,
  params: UiMessageParams = {},
): string {
  return catalog[key].replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name: string) => (
    params[name] === undefined ? placeholder : String(params[name])
  ))
}
