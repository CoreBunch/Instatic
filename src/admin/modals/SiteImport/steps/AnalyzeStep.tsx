/**
 * AnalyzeStep — the "Review import" step of the Super Import wizard.
 *
 * Direction B · Category navigator. The left column is a real navigator: one
 * entry per import category (Pages / Style rules / Media / Color tokens / Fonts
 * / Scripts) with its count and live include-state, plus a persistent
 * "Add more files" affordance and a pinned "Can't import" entry. The right
 * column is a focused detail pane for the selected category — inline route
 * editing for pages, search + per-stylesheet grouping for the (potentially
 * hundreds of) style rules, tiles for media, chips for colour tokens, and
 * simple switch-rows for fonts and scripts.
 *
 * The whole step accepts more files at any time: the dashed button opens a
 * native picker and the modal also listens for HTML5 drag events to show a
 * drop overlay. Both routes call `onAddFiles`, which re-ingests and rebuilds
 * the plan upstream.
 */
import { useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Switch } from '@ui/components/Switch'
import { Checkbox } from '@ui/components/Checkbox'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import type { RailAccent } from '@ui/railAccent'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { DragAndDropSolidIcon } from 'pixel-art-icons/icons/drag-and-drop-solid'
import type { ImportPlan, StylesheetImportMode } from '@core/siteImport'
import type { ImportSelection } from '../SiteImportModal'
import { StylesheetModeRows } from './StylesheetModeRows'
import { ImportStepper } from '../shared/ImportStepper'
import { withSiteImportCategoryTints } from '../shared/importCategoryAccent'
import { FontTokenRows } from './FontTokenRows'
import {
  basename,
  buildMediaGroups,
  buildRuleGroups,
  buildSkippedList,
  pageRuleCount,
  ruleText,
  skippedItemKey,
  styleRuleKey,
} from './analyzeStepDerivations'
import styles from './AnalyzeStep.module.css'

// ---------------------------------------------------------------------------
// Types + static config
// ---------------------------------------------------------------------------

type Category = 'pages' | 'styles' | 'media' | 'colors' | 'fonts' | 'scripts' | 'skipped'

interface CategoryDef {
  id: Exclude<Category, 'skipped'>
  label: string
  accent: RailAccent
  tint: string
}

type BaseCategoryDef = Omit<CategoryDef, 'accent' | 'tint'>

const CATEGORIES: CategoryDef[] = withSiteImportCategoryTints<BaseCategoryDef>([
  { id: 'pages', label: 'Pages' },
  { id: 'styles', label: 'Style rules' },
  { id: 'media', label: 'Media' },
  { id: 'colors', label: 'Color tokens' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'scripts', label: 'Scripts' },
])

/** How many selector rows to render per expanded group before collapsing into a "+N more" line. */
const RULE_ROW_CAP = 60

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

interface AnalyzeStepProps {
  plan: ImportPlan
  siteName: string
  selection: ImportSelection
  pageSlugOverrides: Map<string, string>
  busy: boolean
  onSelectionChange: (next: ImportSelection) => void
  onStylesheetModeChange: (path: string, mode: StylesheetImportMode) => void
  onAddFiles: (files: File[]) => void
  onSlugOverride: (source: string, slug: string) => void
}

export function AnalyzeStep({
  plan,
  siteName,
  selection,
  pageSlugOverrides,
  busy,
  onSelectionChange,
  onStylesheetModeChange,
  onAddFiles,
  onSlugOverride,
}: AnalyzeStepProps) {
  const [active, setActive] = useState<Category>('pages')
  const [query, setQuery] = useState('')
  const [openGroup, setOpenGroup] = useState<string | null>(plan.styleRuleSources[0] ?? null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Derived data ──────────────────────────────────────────────────────────

  const selectedPages = plan.pages.filter((p) => selection.pagesIncluded.has(p.source)).length
  const ruleGroups = buildRuleGroups(plan)
  const mediaGroups = buildMediaGroups(plan)
  const skipped = buildSkippedList(plan)

  const counts: Record<Exclude<Category, 'skipped'>, number> = {
    pages: plan.pages.length,
    styles: plan.styleRules.length + plan.stylesheets.length,
    media: plan.assets.length,
    colors: plan.colors.length,
    fonts: plan.fonts.length + plan.googleFonts.length,
    scripts: plan.scripts.length,
  }
  const includeOn: Record<Exclude<Category, 'skipped'>, boolean> = {
    pages: selection.pagesIncluded.size > 0,
    styles: selection.styleRulesIncluded.size > 0 || selection.stylesheetsIncluded.size > 0,
    media: selection.assetsIncluded.size > 0,
    colors: plan.colors.length > 0,
    fonts: selection.fontsIncluded.size > 0,
    scripts: selection.scriptsIncluded.size > 0,
  }

  // ── Selection mutators ────────────────────────────────────────────────────

  function patch(next: Partial<ImportSelection>) {
    onSelectionChange({ ...selection, ...next })
  }
  function togglePage(source: string) {
    patch({ pagesIncluded: toggleInSet(selection.pagesIncluded, source) })
  }
  function toggleRule(index: number) {
    patch({ styleRulesIncluded: toggleInSet(selection.styleRulesIncluded, index) })
  }
  function toggleRuleGroup(indices: number[], on: boolean) {
    const next = new Set(selection.styleRulesIncluded)
    for (const i of indices) {
      if (on) next.delete(i)
      else next.add(i)
    }
    patch({ styleRulesIncluded: next })
  }
  function toggleAssetGroup(sourcePaths: string[], on: boolean) {
    const next = new Set(selection.assetsIncluded)
    for (const p of sourcePaths) {
      if (on) next.delete(p)
      else next.add(p)
    }
    patch({ assetsIncluded: next })
  }
  function toggleFont(family: string) {
    patch({ fontsIncluded: toggleInSet(selection.fontsIncluded, family) })
  }
  function toggleScript(path: string) {
    patch({ scriptsIncluded: toggleInSet(selection.scriptsIncluded, path) })
  }
  function toggleStylesheet(path: string) {
    patch({ stylesheetsIncluded: toggleInSet(selection.stylesheetsIncluded, path) })
  }

  // ── Add-files (button + drag-drop) ────────────────────────────────────────

  function openPicker() {
    fileInputRef.current?.click()
  }
  function onPicked(files: FileList | null) {
    if (files && files.length > 0) onAddFiles(Array.from(files))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }
  const dragHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    },
    onDragLeave: () => {
      dragDepth.current -= 1
      if (dragDepth.current <= 0) {
        dragDepth.current = 0
        setDragging(false)
      }
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) onAddFiles(Array.from(files))
    },
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const element = (
    <div className={styles.step} {...dragHandlers}>
      <ImportStepper current="review" />

      <div className={styles.layout}>
        {/* Left navigator */}
        <aside className={styles.nav}>
          <p className={styles.navLead}>
            Importing into <strong>{siteName}</strong>
          </p>
          <div className={styles.navList}>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={styles.navItem}
                data-active={active === c.id ? 'true' : undefined}
                data-accent={c.accent}
                data-testid={`site-import-review-category-${c.id}`}
                onClick={() => setActive(c.id)}
              >
                <span className={styles.navDot} style={{ '--tint': c.tint } as CSSProperties} />
                <span className={styles.navLabel}>{c.label}</span>
                <span className={styles.navCount}>{counts[c.id]}</span>
                <span className={styles.navState} data-on={includeOn[c.id] ? 'true' : undefined} />
              </button>
            ))}
          </div>

          <div className={styles.navBottom}>
            <button type="button" className={styles.addFiles} onClick={openPicker} disabled={busy}>
              <span className={styles.addFilesIcon}>
                <DragAndDropSolidIcon size={15} />
              </span>
              <span className={styles.addFilesText}>
                <span className={styles.addFilesTitle}>Add more files</span>
                <span className={styles.addFilesSub}>Drop HTML, CSS, JS or assets, or browse</span>
              </span>
            </button>
            <button
              type="button"
              className={`${styles.navItem} ${styles.navItemWarn}`}
              data-active={active === 'skipped' ? 'true' : undefined}
              onClick={() => setActive('skipped')}
            >
              <WarningDiamondSolidIcon size={13} className={styles.navWarnIcon} />
              <span className={styles.navLabel}>Can&rsquo;t import</span>
              <span className={styles.navCount}>{skipped.length}</span>
              <span />
            </button>
          </div>
        </aside>

        {/* Right detail pane */}
        <div className={styles.detail}>
          {active === 'pages' && renderPages()}
          {active === 'styles' && renderStyles()}
          {active === 'media' && renderMedia()}
          {active === 'colors' && renderColors()}
          {active === 'fonts' && renderFonts()}
          {active === 'scripts' && renderScripts()}
          {active === 'skipped' && renderSkipped()}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        aria-label="Add import files"
        onChange={(e) => onPicked(e.target.files)}
      />

      {dragging && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropCard}>
            <span className={styles.dropIcon}>
              <DragAndDropSolidIcon size={26} />
            </span>
            <h3 className={styles.dropTitle}>Drop to add files</h3>
          </div>
        </div>
      )}
    </div>
  )

  // ── Detail panes ──────────────────────────────────────────────────────────

  function renderPages() {
    return (
      <>
        <DetailHead
          title="Pages"
          sub="Confirm which pages import and set their routes"
          count={selectedPages}
          total={plan.pages.length}
          onAll={() => patch({ pagesIncluded: new Set(plan.pages.map((p) => p.source)) })}
          onNone={() => patch({ pagesIncluded: new Set() })}
        />
        <div className={styles.rows}>
          {plan.pages.map((page) => {
            const on = selection.pagesIncluded.has(page.source)
            const slug = pageSlugOverrides.get(page.source) ?? page.slug
            const rules = pageRuleCount(plan, page.linkedCssPaths)
            return (
              <div key={page.source} className={styles.pageRow} data-off={on ? undefined : 'true'}>
                <Checkbox
                  checked={on}
                  boxSize="sm"
                  onCheckedChange={() => togglePage(page.source)}
                  aria-label={`Include page ${page.title}`}
                />
                <div className={styles.info}>
                  <span className={styles.title}>{page.title}</span>
                  <span className={styles.meta}>
                    {page.source} · {rules} {rules === 1 ? 'rule' : 'rules'}
                  </span>
                </div>
                <Input
                  fieldSize="sm"
                  prefix="/"
                  value={slug}
                  disabled={!on}
                  className={styles.route}
                  placeholder="page-slug"
                  aria-label={`Route for ${page.title}`}
                  onChange={(e) => onSlugOverride(page.source, e.target.value)}
                />
              </div>
            )
          })}
        </div>
      </>
    )
  }

  function renderStyles() {
    const q = query.trim().toLowerCase()
    return (
      <>
        <DetailHead
          title="Style rules"
          sub="Pick how each stylesheet imports — editable rules, or a file kept as-is"
          count={selection.styleRulesIncluded.size}
          total={plan.styleRules.length}
          onAll={() => patch({ styleRulesIncluded: new Set(plan.styleRules.map((_, i) => i)) })}
          onNone={() => patch({ styleRulesIncluded: new Set() })}
        />
        <StylesheetModeRows
          plan={plan}
          stylesheetsIncluded={selection.stylesheetsIncluded}
          busy={busy}
          onToggleStylesheet={toggleStylesheet}
          onStylesheetModeChange={onStylesheetModeChange}
        />
        <div className={styles.toolbar}>
          <SearchBar value={query} onValueChange={setQuery} placeholder="Search selectors…" />
        </div>
        <div className={styles.rows}>
          {ruleGroups.map((group) => {
            const matches = q
              ? group.indices.filter((i) => ruleText(plan, i).toLowerCase().includes(q))
              : group.indices
            if (q && matches.length === 0) return null
            const isOpen = openGroup === group.source || q.length > 0
            const allOn = group.indices.every((i) => selection.styleRulesIncluded.has(i))
            const visible = matches.slice(0, RULE_ROW_CAP)
            const hidden = matches.length - visible.length
            return (
              <div key={group.source} className={styles.group}>
                <div className={styles.groupHead}>
                  <button
                    type="button"
                    className={styles.chevron}
                    data-open={isOpen ? 'true' : undefined}
                    onClick={() => setOpenGroup(isOpen && !q ? null : group.source)}
                    aria-label={isOpen ? `Collapse ${group.label}` : `Expand ${group.label}`}
                  >
                    <ChevronRightIcon size={11} />
                  </button>
                  <Checkbox
                    checked={allOn}
                    boxSize="sm"
                    onCheckedChange={() => toggleRuleGroup(group.indices, allOn)}
                    aria-label={`Include all rules in ${group.label}`}
                  />
                  <span className={styles.groupFile}>{group.label}</span>
                  <span className={styles.meta}>{group.indices.length} rules</span>
                </div>
                {isOpen && (
                  <div className={styles.groupRules}>
                    {visible.map((i) => {
                      const on = selection.styleRulesIncluded.has(i)
                      return (
                        <div key={styleRuleKey(plan, i)} className={styles.ruleRow}>
                          <Checkbox
                            checked={on}
                            boxSize="sm"
                            onCheckedChange={() => toggleRule(i)}
                            aria-label={`Include rule ${ruleText(plan, i)}`}
                          />
                          <span className={styles.ruleName} data-off={on ? undefined : 'true'}>
                            {ruleText(plan, i)}
                          </span>
                        </div>
                      )
                    })}
                    {hidden > 0 && (
                      <div className={styles.ruleMore}>
                        + {hidden} more in {group.label}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </>
    )
  }

  function renderMedia() {
    return (
      <>
        <DetailHead
          title="Media"
          sub="Uploaded to the Media library"
          count={selection.assetsIncluded.size}
          total={plan.assets.length}
          onAll={() => patch({ assetsIncluded: new Set(plan.assets.map((a) => a.sourcePath)) })}
          onNone={() => patch({ assetsIncluded: new Set() })}
        />
        {mediaGroups.length === 0 ? (
          <p className={styles.empty}>No media files in this import.</p>
        ) : (
          <div className={styles.tileGrid}>
            {mediaGroups.map((g) => {
              const allOn = g.sourcePaths.every((p) => selection.assetsIncluded.has(p))
              return (
                <div key={g.label} className={styles.mediaTile}>
                  <span className={styles.thumb} aria-hidden="true" />
                  <div className={styles.info}>
                    <span className={styles.title}>{g.label}</span>
                    <span className={styles.meta}>
                      {g.sourcePaths.length} {g.sourcePaths.length === 1 ? 'file' : 'files'}
                    </span>
                  </div>
                  <Switch
                    checked={allOn}
                    switchSize="sm"
                    onCheckedChange={() => toggleAssetGroup(g.sourcePaths, allOn)}
                    aria-label={`Include ${g.label}`}
                  />
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  function renderColors() {
    return (
      <>
        <DetailHead
          title="Color tokens"
          sub="Root custom properties become palette tokens"
          count={plan.colors.length}
          total={plan.colors.length}
          hideBulk
        />
        {plan.colors.length === 0 ? (
          <p className={styles.empty}>No colour tokens found.</p>
        ) : (
          <div className={styles.colorGrid}>
            {plan.colors.map((c) => (
              <div key={c.slug} className={styles.colorChip}>
                <span
                  className={styles.swatch}
                  style={{ '--swatch': c.value } as CSSProperties}
                  aria-hidden="true"
                />
                <div className={styles.info}>
                  <span className={styles.ruleName}>--{c.slug}</span>
                  <span className={styles.meta}>{c.value}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  function renderFonts() {
    const includedFontCount =
      plan.fonts.filter((font) => selection.fontsIncluded.has(font.family)).length +
      plan.googleFonts.filter((font) => selection.fontsIncluded.has(font.family)).length
    const includedFontTokenCount = plan.fontTokens.filter(
      (token) => !token.family || selection.fontsIncluded.has(token.family),
    ).length

    return (
      <>
        <DetailHead
          title="Fonts"
          sub="Installed families and root font variables"
          count={includedFontCount + includedFontTokenCount}
          total={plan.fonts.length + plan.googleFonts.length + plan.fontTokens.length}
          onAll={() => patch({
            fontsIncluded: new Set([
              ...plan.fonts.map((f) => f.family),
              ...plan.googleFonts.map((f) => f.family),
            ]),
          })}
          onNone={() => patch({ fontsIncluded: new Set() })}
        />
        {plan.fonts.length === 0 && plan.googleFonts.length === 0 && plan.fontTokens.length === 0 ? (
          <p className={styles.empty}>No installable fonts or font tokens in this import.</p>
        ) : (
          <div className={styles.rows}>
            {plan.fonts.map((f) => (
              <div className={styles.listRow} key={f.family}>
                <span className={styles.listIcon}>
                  <HeadingIcon size={14} />
                </span>
                <div className={styles.info}>
                  <span className={styles.title}>{f.family}</span>
                  <span className={styles.meta}>
                    {f.files.length} {f.files.length === 1 ? 'file' : 'files'}
                  </span>
                </div>
                <Switch
                  checked={selection.fontsIncluded.has(f.family)}
                  switchSize="sm"
                  onCheckedChange={() => toggleFont(f.family)}
                  aria-label={`Include font ${f.family}`}
                />
              </div>
            ))}
            {plan.googleFonts.map((f) => (
              <div className={styles.listRow} key={`google:${f.family}`}>
                <span className={styles.listIcon}>
                  <HeadingIcon size={14} />
                </span>
                <div className={styles.info}>
                  <span className={styles.title}>{f.family}</span>
                  <span className={styles.meta}>
                    Google font · {f.variants.length} {f.variants.length === 1 ? 'variant' : 'variants'} · {f.subsets.join(', ')}
                  </span>
                </div>
                <Switch
                  checked={selection.fontsIncluded.has(f.family)}
                  switchSize="sm"
                  onCheckedChange={() => toggleFont(f.family)}
                  aria-label={`Include font ${f.family}`}
                />
              </div>
            ))}
            <FontTokenRows tokens={plan.fontTokens} />
          </div>
        )}
      </>
    )
  }

  function renderScripts() {
    return (
      <>
        <DetailHead
          title="Scripts"
          sub="Attached where the source HTML linked them"
          count={selection.scriptsIncluded.size}
          total={plan.scripts.length}
          onAll={() => patch({ scriptsIncluded: new Set(plan.scripts.map((s) => s.path)) })}
          onNone={() => patch({ scriptsIncluded: new Set() })}
        />
        {plan.scripts.length === 0 ? (
          <p className={styles.empty}>No scripts in this import.</p>
        ) : (
          <div className={styles.rows}>
            {plan.scripts.map((s) => (
              <div className={styles.listRow} key={s.path}>
                <span className={styles.listIcon}>
                  <BracesIcon size={14} />
                </span>
                <div className={styles.info}>
                  <span className={styles.ruleName}>{basename(s.path)}</span>
                  <span className={styles.meta}>{s.path}</span>
                </div>
                <Switch
                  checked={selection.scriptsIncluded.has(s.path)}
                  switchSize="sm"
                  onCheckedChange={() => toggleScript(s.path)}
                  aria-label={`Include script ${s.path}`}
                />
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  function renderSkipped() {
    return (
      <>
        <DetailHead
          title="Can’t import"
          sub="Dropped; your pages are unaffected"
          count={skipped.length}
          total={skipped.length}
          warn
          hideBulk
        />
        {skipped.length === 0 ? (
          <p className={styles.empty}>Nothing was skipped; everything imports cleanly.</p>
        ) : (
          <div className={styles.rows}>
            {skipped.map((s) => (
              <div key={skippedItemKey(s)} className={styles.skipRow}>
                <WarningDiamondSolidIcon size={13} className={styles.navWarnIcon} />
                <div className={styles.info}>
                  <span className={styles.skipLabel}>{s.label}</span>
                  <span className={styles.meta}>{s.reason}</span>
                </div>
                <span className={styles.chip}>{s.kind}</span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return element
}

// ---------------------------------------------------------------------------
// Detail header (title + sub + bulk cluster)
// ---------------------------------------------------------------------------

interface DetailHeadProps {
  title: string
  sub: string
  count: number
  total: number
  warn?: boolean
  hideBulk?: boolean
  onAll?: () => void
  onNone?: () => void
}

function DetailHead({ title, sub, count, total, warn, hideBulk, onAll, onNone }: DetailHeadProps) {
  return (
    <div className={styles.detHead} data-warn={warn ? 'true' : undefined}>
      <div className={styles.detHeadText}>
        <h3 className={styles.detHeadTitle}>{title}</h3>
        <span className={styles.sectionSub}>{sub}</span>
      </div>
      {!hideBulk && (
        <div className={styles.detHeadBulk}>
          <span className={styles.detHeadCount}>
            {count} of {total}
          </span>
          <button type="button" className={styles.link} onClick={onAll}>
            All
          </button>
          <span className={styles.bulkSep}>·</span>
          <button type="button" className={styles.link} onClick={onNone}>
            None
          </button>
        </div>
      )}
    </div>
  )
}
