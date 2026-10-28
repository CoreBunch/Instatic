/**
 * Editorial content for the Dependencies home view: packages worth suggesting
 * for a site, and the category shortcuts.
 *
 * Both are npm-specific — the names are npm's, and the category queries use
 * npm's `keywords:` search syntax — so the home view only shows them when the
 * registry profile says the server is pointed at public npm.
 *
 * The blurbs are ours on purpose. Reading them from the registry would mean
 * one search request per tile on every panel open, which is eight parallel
 * calls to npm's most rate-limited endpoint for text that never changes.
 */
import type { RailAccent } from '@ui/railAccent'
import type { IconComponent } from 'pixel-art-icons/types'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { ArrowsHorizontalIcon } from 'pixel-art-icons/icons/arrows-horizontal'
import { ArrowsVerticalIcon } from 'pixel-art-icons/icons/arrows-vertical'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { ChartSolidIcon } from 'pixel-art-icons/icons/chart-solid'
import { StarSolidIcon } from 'pixel-art-icons/icons/star-solid'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'

interface CuratedPackage {
  name: string
  blurb: string
}

export const CURATED_PACKAGES: readonly CuratedPackage[] = [
  { name: 'three', blurb: '3D scenes and WebGL rendering.' },
  { name: 'gsap', blurb: 'Timeline animation for anything on the page.' },
  { name: 'swiper', blurb: 'Touch sliders and carousels.' },
  { name: 'lenis', blurb: 'Smooth scrolling with real inertia.' },
  { name: 'dayjs', blurb: 'Dates and formatting, 2 kB.' },
  { name: 'motion', blurb: 'Spring and gesture animation.' },
  { name: 'lit', blurb: 'Small, standards-based web components.' },
  { name: 'alpinejs', blurb: 'Sprinkle behaviour straight into markup.' },
]

interface RegistryCategory {
  label: string
  query: string
  icon: IconComponent
  accent: RailAccent
}

export const CATEGORIES: readonly RegistryCategory[] = [
  { label: 'Animation', query: 'keywords:animation', icon: ZapSolidIcon, accent: 'gold' },
  { label: '3D & WebGL', query: 'keywords:webgl', icon: BoxSolidIcon, accent: 'sky' },
  { label: 'Sliders', query: 'keywords:carousel', icon: ArrowsHorizontalIcon, accent: 'peach' },
  { label: 'Scroll', query: 'keywords:scroll', icon: ArrowsVerticalIcon, accent: 'mint' },
  { label: 'Forms', query: 'keywords:form validation', icon: ListBoxSolidIcon, accent: 'lilac' },
  { label: 'Charts', query: 'keywords:chart', icon: ChartSolidIcon, accent: 'lime' },
  { label: 'Icons', query: 'keywords:icons', icon: StarSolidIcon, accent: 'rose' },
  { label: 'Dates', query: 'keywords:date', icon: CalendarSolidIcon, accent: 'cyan' },
]
