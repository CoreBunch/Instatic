import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
/**
 * The "Search & social" and "Head tags" tab panels a settings dialog adds to
 * its own `<Tabs>`. The editor itself loads lazily, when one of the panels
 * first opens, so it stays out of the Site editor body bundle.
 */
import { Suspense, lazy } from 'react'
import type { PageSeo } from '@core/page-tree'
import { Tab, TabPanel } from '@ui/components/Tabs'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SkeletonBlock } from '@ui/components/Skeleton'

const PageSeoEditor = lazy(() =>
  import('./PageSeoEditor').then((m) => ({ default: m.PageSeoEditor })),
)

export function PageSeoTabs() {
  return <>
    <Tab value="search"><SearchSolidIcon size={14} aria-hidden="true" />Search &amp; social</Tab>
    <Tab value="head"><CodeIcon size={14} aria-hidden="true" />Head tags</Tab>
  </>
}

interface PageSeoTabPanelsProps {
  value: PageSeo
  inherited?: PageSeo
  previewContext?: TemplateRenderDataContext
  onChange: (next: PageSeo) => void
  pageTitle: string
  /** Shown above both sections (e.g. how a template's settings apply to its entries). */
  note?: string
}

export function PageSeoTabPanels({ value, inherited, previewContext, onChange, pageTitle, note }: PageSeoTabPanelsProps) {
  return (
    <>
      <TabPanel value="search">
        <Suspense fallback={<SkeletonBlock minHeight={320} ariaLabel="Loading search settings" />}>
          <PageSeoEditor inherited={inherited} previewContext={previewContext} section="search" value={value} onChange={onChange} pageTitle={pageTitle} note={note} />
        </Suspense>
      </TabPanel>
      <TabPanel value="head">
        <Suspense fallback={<SkeletonBlock minHeight={320} ariaLabel="Loading head tags" />}>
          <PageSeoEditor inherited={inherited} previewContext={previewContext} section="head" value={value} onChange={onChange} pageTitle={pageTitle} note={note} />
        </Suspense>
      </TabPanel>
    </>
  )
}
