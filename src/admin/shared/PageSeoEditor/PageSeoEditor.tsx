import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
/**
 * PageSeoEditor — edits a page's `<head>` settings (`PageSeo`): search
 * metadata, the social card, browser chrome hints, extra meta / link tags and
 * JSON-LD blocks. Controlled: the owning dialog keeps the draft and saves it
 * through `parsePageSeo`, which drops blank values.
 *
 * Two sections, picked by the dialog's tabs: `search` (title, description,
 * canonical, robots, Open Graph, Twitter) and `head` (favicon, colours,
 * links, meta, structured data). Field-local validation (a meta name the
 * publisher would refuse, JSON-LD that is not JSON) shows next to the field;
 * `pageSeoProblem` (`./pageSeoProblems`) lets the dialog disable Save with
 * the same reason.
 */
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import { useId, type ReactNode } from 'react'
import {
  PAGE_HEAD_LINK_RELS,
  PAGE_HEAD_PRELOAD_AS,
  type PageHeadLink,
  type PageHeadLinkRel,
  type PageHeadPreloadAs,
  type PageOpenGraph,
  type PageSeo,
  type PageThemeColor,
  type PageTwitterCard,
} from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { SeoImageField } from './SeoImageField'
import styles from './PageSeoEditor.module.css'
import { jsonLdProblem, metaNameProblem } from './pageSeoProblems'

type Section = 'search' | 'head'

interface PageSeoEditorProps {
  section: Section
  value: PageSeo
  inherited?: PageSeo
  previewContext?: TemplateRenderDataContext
  onChange: (next: PageSeo) => void
  /** Shown as the placeholder of the SEO title field. */
  pageTitle: string
  /** Shown above the section. */
  note?: string
}

export function PageSeoEditor({ section, value, inherited = {}, previewContext, onChange, pageTitle, note }: PageSeoEditorProps) {
  const preview = (value?: string) => value && previewContext ? interpolateTokens(value, previewContext) : value
  const set = <K extends keyof PageSeo>(key: K, next: PageSeo[K]) => onChange({ ...value, [key]: next })
  return (
    <div className={styles.root}>
      {note && <p className={styles.note}>{note}</p>}
      {section === 'search'
        ? <SearchSection inherited={inherited} preview={preview} value={value} set={set} pageTitle={pageTitle} />
        : <HeadSection inherited={inherited} preview={preview} value={value} set={set} />}
    </div>
  )
}

type SetField = <K extends keyof PageSeo>(key: K, next: PageSeo[K]) => void

// ---------------------------------------------------------------------------
// Search & social
// ---------------------------------------------------------------------------

type Inheritance = { inherited: PageSeo; preview: (value?: string) => string | undefined }

function SearchSection({ value, inherited, preview, set, pageTitle }: Inheritance & { value: PageSeo; set: SetField; pageTitle: string }) {
  const og = value.openGraph ?? {}
  const twitter = value.twitter ?? {}
  const setOg = (key: keyof PageOpenGraph, next: string) => set('openGraph', { ...og, [key]: next })
  const setTwitter = (key: keyof PageTwitterCard, next: string) => set('twitter', { ...twitter, [key]: next })

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <h3 className={styles.heading}>Search</h3>
        <TextRow label="Title" value={value.title} maxLength={512} inherited={preview(inherited.title)} placeholder={pageTitle} onChange={(next) => set('title', next)}
          hint="Shown in the browser tab and search results. Use {page.title} | {site.name} for a title with a suffix." />
        <TextRow label="Description" inherited={preview(inherited.description)} value={value.description} maxLength={2048} multiline onChange={(next) => set('description', next)}
          hint="Shown in search results." />
        <TextRow label="Canonical URL" maxLength={2048} value={value.canonical} inherited={preview(inherited.canonical)} placeholder={'https://example.com/page'} onChange={(next) => set('canonical', next)} />
        <TextRow label="Robots" maxLength={256} value={value.robots} inherited={preview(inherited.robots)} placeholder={'index, follow'} onChange={(next) => set('robots', next)} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Social card</h3>
        <TextRow label="Title" inherited={preview(inherited.openGraph?.title)} value={og.title} maxLength={512} onChange={(next) => setOg('title', next)} />
        <TextRow label="Description" inherited={preview(inherited.openGraph?.description)} value={og.description} maxLength={2048} multiline onChange={(next) => setOg('description', next)} />
        <SeoImageField label="Social card image" inherited={preview(inherited.openGraph?.image)} value={og.image} onChange={(next) => setOg('image', next)} />
        <TextRow label="Image alt text" maxLength={512} inherited={preview(inherited.openGraph?.imageAlt)} value={og.imageAlt} onChange={(next) => setOg('imageAlt', next)} />
        <TextRow label="Type" value={og.type} maxLength={64} inherited={preview(inherited.openGraph?.type)} placeholder={'website'} onChange={(next) => setOg('type', next)} />
        <TextRow label="Site name" maxLength={256} inherited={preview(inherited.openGraph?.siteName)} value={og.siteName} onChange={(next) => setOg('siteName', next)} />
        <TextRow label="URL" inherited={preview(inherited.openGraph?.url)} value={og.url} maxLength={2048} onChange={(next) => setOg('url', next)} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>X / Twitter</h3>
        <p className={styles.sectionHint}>X uses the social card when no X-specific value is set at any level.</p>
        <Row label="Card">
          {(id) => (
            <Select
              id={id}
              fieldSize="sm"
              value={twitter.card ?? ''}
              onChange={(event) => setTwitter('card', event.target.value)}
              options={[
                { value: '', label: inherited.twitter?.card ? `Inherited · ${preview(inherited.twitter.card)}` : 'Not set' },
                { value: 'summary', label: 'Summary' },
                { value: 'summary_large_image', label: 'Summary, large image' },
                ...(twitter.card && twitter.card !== 'summary' && twitter.card !== 'summary_large_image'
                  ? [{ value: twitter.card, label: twitter.card }]
                  : []),
              ]}
            />
          )}
        </Row>
        <TextRow label="Site account" maxLength={128} value={twitter.site} inherited={preview(inherited.twitter?.site)} placeholder={'@account'} onChange={(next) => setTwitter('site', next)} />
        <TextRow label="Creator" maxLength={128} value={twitter.creator} inherited={preview(inherited.twitter?.creator)} placeholder={'@author'} onChange={(next) => setTwitter('creator', next)} />
        <TextRow label="Title" inherited={preview(inherited.twitter?.title)} value={twitter.title} maxLength={512} onChange={(next) => setTwitter('title', next)} />
        <TextRow label="Description" inherited={preview(inherited.twitter?.description)} value={twitter.description} maxLength={2048} multiline onChange={(next) => setTwitter('description', next)} />
        <SeoImageField label="X / Twitter image" inherited={preview(inherited.twitter?.image)} value={twitter.image} onChange={(next) => setTwitter('image', next)} />
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Head tags
// ---------------------------------------------------------------------------

function HeadSection({ value, inherited, preview, set }: Inheritance & { value: PageSeo; set: SetField }) {
  const themeColors = value.themeColors ?? []
  const links = value.links ?? []
  const meta = value.meta ?? []
  const jsonLd = value.jsonLd ?? []

  const updateAt = <T,>(list: T[], index: number, next: T) => list.map((item, i) => (i === index ? next : item))
  const removeAt = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index)

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <h3 className={styles.heading}>Browser</h3>
        <SeoImageField
          label="Favicon"
          inherited={preview(inherited.favicon?.href)} value={value.favicon?.href}
          hint="Empty uses the inherited favicon."
          onChange={(next) => set('favicon', next ? { href: next } : undefined)}
        />
        <TextRow label="Color scheme" maxLength={64} value={value.colorScheme} inherited={preview(inherited.colorScheme)} placeholder={'light dark'} onChange={(next) => set('colorScheme', next)} />
        <Row label="Theme colors">
          {() => (
            <div className={styles.list}>
              {!themeColors.length && <InheritedList values={inherited.themeColors?.map((item) => [preview(item.color), preview(item.media)].filter(Boolean).join(' · '))} />}
          {themeColors.map((theme, index) => (
                <div key={index} className={styles.listRow}>
                  <Input fieldSize="sm" aria-label="Theme color" placeholder="#ffffff" maxLength={64} value={theme.color}
                    onChange={(event) => set('themeColors', updateAt<PageThemeColor>(themeColors, index, { ...theme, color: event.target.value }))} />
                  <Input fieldSize="sm" aria-label="Theme color media query" placeholder="(prefers-color-scheme: dark)" maxLength={256} value={theme.media ?? ''}
                    onChange={(event) => set('themeColors', updateAt<PageThemeColor>(themeColors, index, { ...theme, media: event.target.value }))} />
                  <RemoveButton label="Remove theme color" onClick={() => set('themeColors', removeAt(themeColors, index))} />
                </div>
              ))}
              <AddButton label="Add theme color" disabled={themeColors.length >= 8}
                onClick={() => set('themeColors', [...themeColors, { color: '' }])} />
            </div>
          )}
        </Row>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Links</h3>
        <p className={styles.sectionHint}>Alternate versions, preloaded fonts and images, touch icons, a web manifest.</p>
        <div className={styles.list}>
          {!links.length && <InheritedList values={inherited.links?.map((item) => [item.rel, preview(item.href), item.as, item.type, item.sizes, item.hreflang, item.title, item.media, item.crossorigin].filter(Boolean).join(' · '))} />}
          {links.map((link, index) => (
            <LinkEditor key={index} link={link}
              onChange={(next) => set('links', updateAt(links, index, next))}
              onRemove={() => set('links', removeAt(links, index))} />
          ))}
          <AddButton label="Add link" disabled={links.length >= 64}
            onClick={() => set('links', [...links, { rel: 'alternate', href: '' }])} />
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Meta tags</h3>
        <p className={styles.sectionHint}>Extra tags such as og:image:width or a site verification code.</p>
        <div className={styles.list}>
          {!meta.length && <InheritedList values={inherited.meta?.map((item) => `${item.name}: ${preview(item.content)}`)} />}
          {meta.map((entry, index) => {
            const problem = metaNameProblem(entry)
            return (
              <div key={index} className={styles.stack}>
                <div className={styles.listRow}>
                  <Select fieldSize="sm" aria-label="Meta attribute" value={entry.attribute}
                    onChange={(event) => set('meta', updateAt(meta, index, { ...entry, attribute: event.target.value === 'property' ? 'property' : 'name' }))}
                    options={[{ value: 'name', label: 'name' }, { value: 'property', label: 'property' }]} />
                  <Input fieldSize="sm" aria-label="Meta name" placeholder="og:image:width" maxLength={128} value={entry.name} invalid={Boolean(problem)}
                    onChange={(event) => set('meta', updateAt(meta, index, { ...entry, name: event.target.value }))} />
                  <Input fieldSize="sm" aria-label="Meta content" placeholder="Content" maxLength={2048} value={entry.content}
                    onChange={(event) => set('meta', updateAt(meta, index, { ...entry, content: event.target.value }))} />
                  <RemoveButton label="Remove meta tag" onClick={() => set('meta', removeAt(meta, index))} />
                </div>
                {problem && <p role="alert" className={styles.error}>{problem}</p>}
              </div>
            )
          })}
          <AddButton label="Add meta tag" disabled={meta.length >= 64}
            onClick={() => set('meta', [...meta, { attribute: 'name', name: '', content: '' }])} />
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Structured data</h3>
        <p className={styles.sectionHint}>JSON-LD, published as script type=&quot;application/ld+json&quot;.</p>
        <div className={styles.list}>
          {!jsonLd.length && <InheritedList values={inherited.jsonLd} />}
          {jsonLd.map((block, index) => {
            const problem = jsonLdProblem(block)
            return (
              <div key={index} className={styles.stack}>
                <div className={styles.blockRow}>
                  <Textarea fieldSize="sm" monospace rows={6} maxLength={65536} aria-label={`Structured data block ${index + 1}`} value={block}
                    invalid={Boolean(problem)} placeholder={'{ "@context": "https://schema.org", "@type": "Organization" }'}
                    onChange={(event) => set('jsonLd', updateAt(jsonLd, index, event.target.value))} />
                  <RemoveButton label="Remove structured data block" onClick={() => set('jsonLd', removeAt(jsonLd, index))} />
                </div>
                {problem && <p role="alert" className={styles.error}>{problem}</p>}
              </div>
            )
          })}
          <AddButton label="Add structured data" disabled={jsonLd.length >= 16}
            onClick={() => set('jsonLd', [...jsonLd, ''])} />
        </div>
      </section>
    </div>
  )
}

/** Mirrors `PageHeadLinkSchema` so a field can never hold more than the cell keeps. */
const LINK_LIMITS = { type: 128, title: 256, hreflang: 64, media: 256, sizes: 64 } as const

const REL_OPTIONS = PAGE_HEAD_LINK_RELS.map((rel) => ({ value: rel, label: rel }))
const AS_OPTIONS = PAGE_HEAD_PRELOAD_AS.map((as) => ({ value: as, label: as }))

function InheritedList({ values }: { values?: string[] }) {
  if (!values?.length) return null
  return <div className={styles.inheritedList}><span>Inherited</span><ul>{values.map((value, i) => <li key={i}>{value}</li>)}</ul></div>
}

function LinkEditor({ link, onChange, onRemove }: {
  link: PageHeadLink
  onChange: (next: PageHeadLink) => void
  onRemove: () => void
}) {
  const imageLink = link.rel === 'icon' || link.rel === 'apple-touch-icon' || link.rel === 'mask-icon'
    || (link.rel === 'preload' && link.as === 'image')
  const field = (key: 'type' | 'title' | 'hreflang' | 'media' | 'sizes', label: string, placeholder: string) => (
    <Input fieldSize="sm" aria-label={`Link ${label}`} placeholder={placeholder} maxLength={LINK_LIMITS[key]} value={link[key] ?? ''}
      onChange={(event) => onChange({ ...link, [key]: event.target.value })} />
  )
  return (
    <div className={styles.linkCard}>
      <div className={styles.listRow}>
        <Select fieldSize="sm" aria-label="Link rel" value={link.rel} options={REL_OPTIONS}
          onChange={(event) => {
            const rel = event.target.value as PageHeadLinkRel
            // A preload needs a destination; anything else must not carry one.
            const { as: _as, ...rest } = link
            onChange(rel === 'preload' ? { ...rest, rel, as: link.as ?? 'font' } : { ...rest, rel })
          }} />
        {!imageLink && <Input fieldSize="sm" aria-label="Link URL" placeholder="URL" maxLength={2048} value={link.href}
          onChange={(event) => onChange({ ...link, href: event.target.value })} />}
        <RemoveButton label="Remove link" onClick={onRemove} />
      </div>
      {imageLink && <SeoImageField label="Link image" value={link.href} onChange={(href) => onChange({ ...link, href })} />}
      <div className={styles.linkDetails}>
        {link.rel === 'preload' && (
          <Select fieldSize="sm" aria-label="Link as" value={link.as} options={AS_OPTIONS}
            onChange={(event) => onChange({ ...link, as: event.target.value as PageHeadPreloadAs })} />
        )}
        {field('type', 'type', 'Type, e.g. font/woff2')}
        {link.rel === 'alternate' && field('hreflang', 'language', 'Language, e.g. de')}
        {field('title', 'title', 'Title')}
        {field('media', 'media', 'Media query')}
        {(link.rel === 'icon' || link.rel === 'apple-touch-icon') && field('sizes', 'sizes', 'Sizes, e.g. 180x180')}
        <Select fieldSize="sm" aria-label="Link crossorigin" value={link.crossorigin ?? ''}
          onChange={(event) => {
            const value = event.target.value
            const { crossorigin: _drop, ...rest } = link
            onChange(value === 'anonymous' || value === 'use-credentials' ? { ...rest, crossorigin: value } : rest)
          }}
          options={[
            { value: '', label: 'No crossorigin' },
            { value: 'anonymous', label: 'crossorigin' },
            { value: 'use-credentials', label: 'use-credentials' },
          ]} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Row({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      <div className={styles.control}>
        {children(id)}
        {hint && <p className={styles.hint}>{hint}</p>}
      </div>
    </div>
  )
}

function TextRow({ label, value, maxLength, inherited, placeholder, hint, multiline, onChange }: {
  label: string
  value: string | undefined
  /** The schema's limit for this field (`PageSeoSchema`), so nothing typed is dropped on save. */
  maxLength: number
  placeholder?: string
  inherited?: string
  hint?: string
  multiline?: boolean
  onChange: (next: string) => void
}) {
  return (
    <Row label={label} hint={!value && inherited ? ['Inherited.', hint].filter(Boolean).join(' ') : hint}>
      {(id) => multiline
        ? <Textarea id={id} fieldSize="sm" rows={3} resize="vertical" maxLength={maxLength} value={value ?? ''} placeholder={inherited || placeholder}
            onChange={(event) => onChange(event.target.value)} />
        : <Input id={id} fieldSize="sm" maxLength={maxLength} value={value ?? ''} placeholder={inherited || placeholder} autoComplete="off" spellCheck={false}
            onChange={(event) => onChange(event.target.value)} />}
    </Row>
  )
}

function AddButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <div>
      <Button variant="secondary" size="xs" type="button" disabled={disabled} onClick={onClick}
        tooltip={disabled ? 'This list is full.' : undefined}>
        <PlusIcon size={12} aria-hidden="true" />
        {label}
      </Button>
    </div>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" type="button" iconOnly aria-label={label} tooltip={label} dangerHover onClick={onClick}>
      <TrashSolidIcon size={12} aria-hidden="true" />
    </Button>
  )
}
