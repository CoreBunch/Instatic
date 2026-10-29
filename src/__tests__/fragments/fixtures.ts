/**
 * Two small made-up sites for the fragment engine tests.
 *
 * SOURCE ("Atelier") has everything a section can depend on: classes, an
 * ambient rule built on them, a custom condition, a colour token with
 * generated variants, a font token backed by a custom font, type and space
 * scale steps, a root custom property, a nested Visual Component pair, a loop
 * over a data table with media cells, a CMS form, an image, a background
 * image, a page link, a keyframes animation, and a wrapper class on an
 * ancestor (an outside dependency).
 *
 * TARGET ("Harbour") overlaps on purpose: it already has a `hero` class with
 * different styles, a `primary` colour, shorter type and space scales, the
 * `Card` component, the `projects` table without the `cover` field, an
 * `about` page, and `--radius` on its root.
 */

import type { DataRow, DataTable } from '@core/data/schemas'
import type { FrameworkSettings } from '@core/framework-schema'
import { generateFrameworkUtilityClasses } from '@core/framework'
import type { PageNode, SiteDocument, StyleRule } from '@core/page-tree'
import { extractFragment, fragmentSourceFromSite, type FragmentSelection, type FragmentSourceMedia } from '@core/fragments'
import { makeNode, makePage, makeSite, makeVC, makeVCNode, makeVCTree } from '../fixtures'

const T = 1_700_000_000_000

export function rule(
  id: string,
  partial: Partial<StyleRule> & Pick<StyleRule, 'name' | 'kind' | 'selector' | 'order'>,
): StyleRule {
  return {
    id,
    styles: {},
    contextStyles: {},
    createdAt: T,
    updatedAt: T,
    ...partial,
  }
}

function colorToken(id: string, slug: string, value: string, order: number, shades: boolean) {
  return {
    id,
    category: '',
    slug,
    lightValue: value,
    darkValue: '',
    darkModeEnabled: false,
    generateUtilities: { text: true, background: true, border: false, fill: false },
    generateTransparent: true,
    generateShades: { enabled: shades, count: shades ? 3 : 0 },
    generateTints: { enabled: false, count: 0 },
    order,
    createdAt: T,
    updatedAt: T,
  }
}

function typeGroup(id: string, steps: string, baseScaleIndex: number) {
  return {
    id,
    name: 'Text',
    namingConvention: 'text',
    min: { fontSize: 16, scaleRatio: 1.125 },
    max: { fontSize: 18, scaleRatio: 1.333 },
    steps,
    baseScaleIndex,
    mode: 'fluid' as const,
    order: 0,
    createdAt: T,
    updatedAt: T,
  }
}

function spaceGroup(id: string, steps: string, baseScaleIndex: number) {
  return {
    id,
    name: 'Space',
    namingConvention: 'space',
    min: { size: 16, scaleRatio: 1.25 },
    max: { size: 28, scaleRatio: 1.414 },
    steps,
    baseScaleIndex,
    mode: 'fluid' as const,
    order: 0,
    createdAt: T,
    updatedAt: T,
  }
}

function withFrameworkClasses(
  framework: FrameworkSettings,
  rules: Record<string, StyleRule>,
): Record<string, StyleRule> {
  return { ...generateFrameworkUtilityClasses(framework), ...rules }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export const SOURCE_FRAMEWORK: FrameworkSettings = {
  colors: {
    tokens: [
      colorToken('col-primary', 'primary', '#3366ff', 0, true),
      colorToken('col-accent', 'accent', '#ff8800', 1, false),
      colorToken('col-unused', 'unused', '#00aa00', 2, false),
    ],
  },
  typography: {
    groups: [typeGroup('type-1', 'xs,s,m,l,xl,2xl', 2)],
    classes: [{ id: 'gen-text', tabId: 'type-1', name: 'text-*', property: ['font-size'] }],
  },
  spacing: {
    groups: [spaceGroup('space-1', 's,m,l', 1)],
    classes: [{ id: 'gen-pad', tabId: 'space-1', name: 'padding-*', property: ['padding-top'] }],
  },
}

/** The framework id of a generated class, by its name. */
export function frameworkClassId(framework: FrameworkSettings, name: string): string {
  const found = Object.values(generateFrameworkUtilityClasses(framework)).find((c) => c.name === name)
  if (!found) throw new Error(`no framework class ${name}`)
  return found.id
}

export const SOURCE_MEDIA: FragmentSourceMedia[] = [
  { id: 'media-photo', path: '/uploads/photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 3, width: 800, height: 600, alt: 'A photo' },
  { id: 'media-bg', path: '/uploads/bg.jpg', filename: 'bg.jpg', mimeType: 'image/jpeg', sizeBytes: 3 },
  { id: 'media-cover', path: '/uploads/cover.jpg', filename: 'cover.jpg', mimeType: 'image/jpeg', sizeBytes: 3 },
  { id: 'media-font', path: '/uploads/inter.woff2', filename: 'inter.woff2', mimeType: 'font/woff2', sizeBytes: 3 },
  { id: 'media-unused', path: '/uploads/unused.jpg', filename: 'unused.jpg', mimeType: 'image/jpeg', sizeBytes: 3 },
]

/** Deterministic bytes per media id, so hashes are stable across runs. */
export function mediaBytesFor(id: string): Uint8Array {
  return new TextEncoder().encode(`bytes:${id}`)
}

export function sourceMediaWithBytes(): FragmentSourceMedia[] {
  return SOURCE_MEDIA.map((m) => ({ ...m, sizeBytes: mediaBytesFor(m.id).byteLength, readBytes: () => mediaBytesFor(m.id) }))
}

export const SOURCE_TABLES: DataTable[] = [
  {
    id: 'tbl-projects',
    name: 'Projects',
    slug: 'projects',
    kind: 'data',
    singularLabel: 'Project',
    pluralLabel: 'Projects',
    routeBase: '',
    primaryFieldId: 'title',
    fields: [
      { id: 'title', label: 'Title', type: 'text' },
      { id: 'cover', label: 'Cover', type: 'media', mediaKind: 'image' },
      { id: 'owner', label: 'Owner', type: 'relation', targetTableId: 'tbl-people' },
    ],
    system: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'tbl-contact',
    name: 'Contact',
    slug: 'contact',
    kind: 'data',
    singularLabel: 'Message',
    pluralLabel: 'Messages',
    routeBase: '',
    primaryFieldId: 'name',
    fields: [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'email', label: 'Email', type: 'email' },
    ],
    system: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

function row(id: string, tableId: string, slug: string, cells: Record<string, unknown>, status: DataRow['status'] = 'published'): DataRow {
  return {
    id,
    tableId,
    cells,
    slug,
    status,
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

export const SOURCE_ROWS: DataRow[] = [
  row('row-1', 'tbl-projects', 'harbour', { title: 'Harbour', cover: 'media-cover', owner: 'person-1' }),
  row('row-2', 'tbl-projects', 'mill', { title: 'Mill <a href="cms:page:page-about">more</a>', cover: null }, 'draft'),
  row('row-3', 'tbl-contact', 'm1', { name: 'Someone', email: 'a@example.com' }),
]

export function makeSourceSite(): SiteDocument {
  const framework = structuredClone(SOURCE_FRAMEWORK)
  const textXl = frameworkClassId(framework, 'text-xl')
  const textPrimary = frameworkClassId(framework, 'text-primary')

  const badge = makeVC({
    id: 'vc-badge',
    name: 'Badge',
    tree: makeVCTree('badge-root', [
      makeVCNode({ id: 'badge-root', moduleId: 'base.container', classIds: ['cls-badge'] }),
    ]),
  })
  const card = makeVC({
    id: 'vc-card',
    name: 'Card',
    tree: makeVCTree('card-root', [
      makeVCNode({ id: 'card-root', moduleId: 'base.container', classIds: ['cls-card'], children: ['card-badge'] }),
      makeVCNode({ id: 'card-badge', moduleId: 'base.visual-component-ref', props: { componentId: 'vc-badge', propOverrides: {} } }),
    ]),
  })

  const nodes: Record<string, PageNode> = {
    body: makeNode({ id: 'body', moduleId: 'base.body', children: ['wrap'] }),
    wrap: makeNode({ id: 'wrap', moduleId: 'base.container', classIds: ['cls-page-wrap'], children: ['hero', 'other'] }),
    hero: makeNode({
      id: 'hero',
      moduleId: 'base.container',
      classIds: ['cls-hero', 'cls-scoped'],
      children: ['title', 'photo', 'link', 'card-ref', 'loop', 'form'],
    }),
    title: makeNode({ id: 'title', moduleId: 'base.text', props: { text: 'Hello' }, classIds: ['cls-hero-title', textXl, textPrimary] }),
    photo: makeNode({ id: 'photo', moduleId: 'base.image', props: { src: '/uploads/photo.jpg' } }),
    link: makeNode({ id: 'link', moduleId: 'base.link', props: { href: 'cms:page:page-about#team', text: 'About' } }),
    'card-ref': makeNode({ id: 'card-ref', moduleId: 'base.visual-component-ref', props: { componentId: 'vc-card', propOverrides: {} } }),
    loop: makeNode({
      id: 'loop',
      moduleId: 'base.loop',
      props: { sourceId: 'data.rows', filters: { tableId: 'tbl-projects' }, orderBy: 'cell:title' },
      children: ['loop-item'],
    }),
    'loop-item': makeNode({
      id: 'loop-item',
      moduleId: 'base.text',
      props: { text: '{currentEntry.title}' },
      dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
    }),
    form: makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'cms', formId: 'contact', targetTableId: 'tbl-contact' } }),
    other: makeNode({ id: 'other', moduleId: 'base.text', props: { text: 'Not selected' }, classIds: ['cls-unrelated'] }),
  }

  nodes.hero.inlineStyles = { gap: 'var(--space-s)' }

  const styleRules = withFrameworkClasses(framework, {
    'cls-root': rule('cls-root', {
      name: ':root', kind: 'ambient', selector: ':root', order: 0,
      styles: { '--radius': '12px', '--shadow': '0 0 4px var(--primary-50)', '--unused-prop': '1px' },
    }),
    'cls-page-wrap': rule('cls-page-wrap', { name: 'page-wrap', kind: 'class', selector: '.page-wrap', order: 1, styles: { maxWidth: '1200px' } }),
    'cls-hero': rule('cls-hero', {
      name: 'hero', kind: 'class', selector: '.hero', order: 2,
      styles: {
        paddingTop: 'var(--space-l)',
        backgroundImage: "url('/uploads/bg.jpg')",
        borderRadius: 'var(--radius)',
        animation: 'fade 1s ease',
      },
      contextStyles: { tablet: { paddingTop: '0' }, 'media:(hover: hover)': { opacity: '0.9' } },
    }),
    'cls-hero-title': rule('cls-hero-title', {
      name: 'hero-title', kind: 'class', selector: '.hero-title', order: 3,
      styles: { fontFamily: 'var(--font-heading)', color: 'var(--primary-d-2)', boxShadow: 'var(--shadow)' },
    }),
    'cls-hero-hover': rule('cls-hero-hover', {
      name: '.hero .hero-title:hover', kind: 'ambient', selector: '.hero .hero-title:hover', order: 4,
      styles: { color: 'var(--accent)' },
    }),
    'cls-wrap-h': rule('cls-wrap-h', { name: '.page-wrap .hero-title', kind: 'ambient', selector: '.page-wrap .hero-title', order: 5, styles: { margin: '0' } }),
    'cls-wrap-other': rule('cls-wrap-other', { name: '.page-wrap .footer', kind: 'ambient', selector: '.page-wrap .footer', order: 6, styles: { margin: '0' } }),
    'cls-unrelated': rule('cls-unrelated', { name: 'unrelated', kind: 'class', selector: '.unrelated', order: 7, styles: { color: 'var(--unused)' } }),
    'cls-keyframes': rule('cls-keyframes', {
      name: '@keyframes fade', kind: 'ambient', selector: '@keyframes fade', order: 8,
      rawCss: '@keyframes fade {\n  from {\n    opacity: 0;\n  }\n}',
    }),
    'cls-card': rule('cls-card', { name: 'card', kind: 'class', selector: '.card', order: 9, styles: { background: 'var(--accent)', borderRadius: 'var(--radius)' } }),
    'cls-badge': rule('cls-badge', { name: 'badge', kind: 'class', selector: '.badge', order: 10, styles: { color: 'var(--primary)' } }),
    'cls-scoped': rule('cls-scoped', {
      name: 'hero-style', kind: 'class', selector: '.hero-style', order: 11,
      scope: { type: 'node', nodeId: 'hero', role: 'module-style' }, styles: { margin: '1px' },
    }),
  })

  const site = makeSite({
    id: 'site-atelier',
    name: 'Atelier',
    pages: [
      makePage({ id: 'page-home', slug: 'index', title: 'Home', rootNodeId: 'body', nodes }),
      makePage({ id: 'page-about', slug: 'about', title: 'About', rootNodeId: 'about-body' }),
    ],
    styleRules,
    settings: {
      shortcuts: {},
      framework,
      fonts: {
        items: [{
          id: 'font-inter',
          source: 'custom',
          family: 'Inter',
          variants: ['400'],
          subsets: ['latin'],
          files: [{ variant: '400', subset: 'latin', path: '/uploads/inter.woff2', format: 'woff2', mediaAssetId: 'media-font' }],
          createdAt: T,
          updatedAt: T,
        }],
        tokens: [{ id: 'tok-heading', name: 'Heading', variable: 'font-heading', familyId: 'font-inter', fallback: 'sans-serif', order: 0, createdAt: T, updatedAt: T }],
      },
    },
    visualComponents: [card, badge],
  })
  site.conditions = [{ id: 'media:(hover: hover)', label: 'Hover', condition: { kind: 'media', query: '(hover: hover)' } }]
  return site
}

/** The source site as an extraction source, media bytes included. */
export function sourceWithBytes(site: SiteDocument = makeSourceSite()) {
  return fragmentSourceFromSite(site, { tables: SOURCE_TABLES, rows: SOURCE_ROWS, media: sourceMediaWithBytes() })
}

/** Extract from the source site; by default the `hero` section. */
export function extractFromSource(selection: FragmentSelection = { pageId: 'page-home', rootNodeIds: ['hero'] }) {
  return extractFragment(sourceWithBytes(), selection)
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

export function makeTargetSite(): SiteDocument {
  const framework: FrameworkSettings = {
    colors: { tokens: [colorToken('t-primary', 'primary', '#111111', 0, false)] },
    typography: {
      groups: [typeGroup('t-type', 'xs,s,m,l', 2)],
      classes: [{ id: 't-gen-text', tabId: 't-type', name: 'text-*', property: ['font-size'] }],
    },
    spacing: { groups: [spaceGroup('t-space', 'm,l', 0)] },
  }
  const card = makeVC({
    id: 't-vc-card',
    name: 'Card',
    tree: makeVCTree('t-card-root', [makeVCNode({ id: 't-card-root', moduleId: 'base.container' })]),
  })
  return makeSite({
    id: 'site-harbour',
    name: 'Harbour',
    pages: [
      makePage({
        id: 't-home', slug: 'index', title: 'Home', rootNodeId: 't-body',
        nodes: {
          't-body': makeNode({ id: 't-body', moduleId: 'base.body', children: ['t-section'] }),
          't-section': makeNode({ id: 't-section', moduleId: 'base.container', classIds: ['t-hero'] }),
        },
      }),
      makePage({ id: 't-about', slug: 'about', title: 'About us', rootNodeId: 't-about-body' }),
    ],
    styleRules: withFrameworkClasses(framework, {
      't-root': rule('t-root', { name: ':root', kind: 'ambient', selector: ':root', order: 0, styles: { '--radius': '2px' } }),
      't-hero': rule('t-hero', { name: 'hero', kind: 'class', selector: '.hero', order: 1, styles: { paddingTop: '99px' } }),
      't-hover': rule('t-hover', {
        name: '.hero .hero-title:hover', kind: 'ambient', selector: '.hero .hero-title:hover', order: 2,
        styles: { color: 'black' },
      }),
    }),
    settings: { shortcuts: {}, framework },
    visualComponents: [card],
  })
}

export const TARGET_TABLES: DataTable[] = [
  {
    ...SOURCE_TABLES[0],
    id: 't-tbl-projects',
    fields: [{ id: 'title', label: 'Title', type: 'text' }],
  },
]
