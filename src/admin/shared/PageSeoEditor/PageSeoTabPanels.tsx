/**
 * The "Search & social" and "Head tags" tab panels a settings dialog adds to
 * its own `<Tabs>`. The editor itself loads lazily, when one of the panels
 * first opens, so it stays out of the Site editor body bundle.
 */
import { Suspense, lazy } from 'react'
import type { PageSeo } from '@core/page-tree'
import { TabPanel } from '@ui/components/Tabs'
import { SkeletonBlock } from '@ui/components/Skeleton'

const PageSeoEditor = lazy(() =>
  import('./PageSeoEditor').then((m) => ({ default: m.PageSeoEditor })),
)

interface PageSeoTabPanelsProps {
  value: PageSeo
  onChange: (next: PageSeo) => void
  pageTitle: string
  /** Shown above both sections (e.g. how a template's settings apply to its entries). */
  note?: string
}

export function PageSeoTabPanels({ value, onChange, pageTitle, note }: PageSeoTabPanelsProps) {
  return (
    <>
      <TabPanel value="search">
        <Suspense fallback={<SkeletonBlock minHeight={320} ariaLabel="Loading search settings" />}>
          <PageSeoEditor section="search" value={value} onChange={onChange} pageTitle={pageTitle} note={note} />
        </Suspense>
      </TabPanel>
      <TabPanel value="head">
        <Suspense fallback={<SkeletonBlock minHeight={320} ariaLabel="Loading head tags" />}>
          <PageSeoEditor section="head" value={value} onChange={onChange} pageTitle={pageTitle} note={note} />
        </Suspense>
      </TabPanel>
    </>
  )
}
