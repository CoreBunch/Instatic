/**
 * OpenLivePageButton — toolbar icon that opens the live site in a new tab.
 *
 * Sits in the Toolbar's right cluster next to `AccountMenuButton`. Rendered
 * by `Toolbar.tsx` itself (not the layout-supplied `rightSlot`) so the button
 * appears on every admin route — Site editor, Content, Plugins, Users,
 * Account, plugin admin pages — with zero per-layout wiring.
 *
 * Target URL:
 *   - Site editor with an active page → that page's public path
 *     (e.g. `/about`).
 *   - Site editor editing a template → the page / post the template is
 *     previewed against (templates have no routable slug of their own —
 *     opening one would 404). An Everywhere template resolves to the
 *     previewed page (e.g. home → `/`); a postTypes template resolves to
 *     the previewed published row (e.g. `/blog/getting-started`).
 *   - Content workspace with a selected entry → the entry's public path
 *     (e.g. `/blog/getting-started`).
 *   - Every other admin route → site root (`/`).
 *
 * The path is read from `useAdminUi` (the tiny shared store) — NOT the
 * editor store — so this component is safe to mount on `AdminPageLayout`
 * without pulling the ~165 KB editor chunk into the non-editor bundle.
 * Each workspace publishes the current document's public path into
 * `adminUi.activeLivePath` and clears it on unmount: the Content layout
 * does it inline, while the Site editor delegates to `useActiveLivePath`
 * in its lazy editor body (which also resolves the template-preview
 * target). Non-editor layouts never write the field, so it naturally
 * stays `null` outside an editing surface.
 */
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { useAdminUi } from '@admin/state/adminUi'

export function OpenLivePageButton({ labeled = false }: { labeled?: boolean }) {
  const activeLivePath = useAdminUi((s) => s.activeLivePath)
  const target = activeLivePath ?? '/'
  const tooltip = activeLivePath ? 'Open live page' : 'Open live site'

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly={!labeled}
      aria-label={tooltip}
      tooltip={labeled ? undefined : tooltip}
      data-testid="toolbar-open-live-page-btn"
      onClick={() => {
        window.open(target, '_blank', 'noopener,noreferrer')
      }}
    >
      {labeled ? 'View live' : <ExternalLinkSolidIcon size={16} aria-hidden="true" />}
    </Button>
  )
}
