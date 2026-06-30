import { type MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import type { resolveFrameworkPreferences } from '@core/framework'
import { Section } from '@ui/components/Section'
import { ClassGeneratorList } from './ClassGeneratorList'
import { ScalesEditor } from './ScalesEditor'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './FrameworkScalePanel.module.css'

interface PanelBodyProps<G extends GroupShape, C extends GeneratorShape> {
  /** Currently active scale, or null when there are no scales yet. */
  group: G | null
  /** All scale groups, sorted — needed for the in-section FilterBar tab list. */
  groups: G[]
  /** Whether the entire scale module is disabled (typography / spacing). */
  isDisabled: boolean
  adapter: ScaleAdapter<G, C>
  preferences: ReturnType<typeof resolveFrameworkPreferences>
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  /** Switch the active scale (called by the FilterBar inside the Scales section). */
  onActivateGroup: (groupId: string) => void
  /** Append a new scale and switch to it. */
  onAddGroup: () => void
  /** Delete the active scale (confirms first). */
  onDeleteGroup: () => void
  classGenerators: C[]
}

/**
 * Renders the full vertical stack of sections (top extras → Scales → Utilities
 * → bottom extras). Empty/disabled states live INSIDE the Scales section's
 * body — they no longer replace the whole panel — so independent extra
 * sections (e.g. the Typography → Fonts library) stay reachable even when no
 * scale exists or the module is disabled.
 */
export function PanelBody<G extends GroupShape, C extends GeneratorShape>({
  group,
  groups,
  isDisabled,
  adapter,
  preferences,
  onContextMenu,
  onActivateGroup,
  onAddGroup,
  onDeleteGroup,
  classGenerators,
}: PanelBodyProps<G, C>) {
  // Split extra sections by position so we can render the 'top' ones before
  // the built-in Scales section and the 'bottom' ones after Utilities.
  const topExtraSections = adapter.extraSections?.filter((s) => s.position === 'top') ?? []
  const bottomExtraSections = adapter.extraSections?.filter((s) => s.position !== 'top') ?? []

  return (
    <div className={styles.editor}>
      {/* Top-positioned extra sections — e.g. Typography → Fonts library lives
          above the Scales section so the user encounters fonts first. These
          render regardless of whether a scale exists or the module is
          disabled, because they're independent surfaces (fonts are stored
          on `site.settings.fonts`, not on the typography framework). */}
      {topExtraSections.map((section) => (
        <Section
          key={section.id}
          title={section.title}
          defaultOpen={section.defaultOpen ?? false}
          icon={section.icon}
        >
          <div className={styles.sectionBody}>{section.render(group)}</div>
        </Section>
      ))}

      {/* Scales section — scale picker (FilterBar), name + prefix, mode toggle,
          fluid/manual editor with chart. When there are no scales or the
          module is disabled, the section renders an inline empty state so
          the surrounding sections stay visible. */}
      <Section title="Scales" defaultOpen icon={adapter.scalesSectionIcon}>
        <div className={styles.sectionBody}>
          {isDisabled ? (
            <EmptyState
              plain
              compact
              title={`${adapter.title} module is disabled.`}
              action={
                <Button variant="secondary" size="sm" onClick={adapter.onToggleDisabled}>
                  Enable
                </Button>
              }
            />
          ) : group === null ? (
            <EmptyState
              plain
              compact
              title={`No ${adapter.title.toLowerCase()} scales yet.`}
              action={
                <Button variant="secondary" size="sm" onClick={onAddGroup}>
                  Create scale
                </Button>
              }
            />
          ) : (
            <ScalesEditor<G, C>
              group={group}
              groups={groups}
              adapter={adapter}
              preferences={preferences}
              onContextMenu={onContextMenu}
              onActivateGroup={onActivateGroup}
              onAddGroup={onAddGroup}
              onDeleteGroup={onDeleteGroup}
            />
          )}
        </div>
      </Section>

      {/* Utilities section — class generator (utility class patterns).
          Hidden when no scale exists (utility classes are bound to a scale)
          or when the module is disabled. The icon (`{ }`) reads as "code
          that gets generated". */}
      {!isDisabled && group !== null && (
        <Section title="Utilities" defaultOpen icon={BracesIcon}>
          <div className={styles.sectionBody}>
            <ClassGeneratorList<C>
              groupId={group.id}
              groupNamingConvention={group.namingConvention}
              adapter={adapter as unknown as ScaleAdapter<GroupShape, C>}
              classes={classGenerators}
            />
          </div>
        </Section>
      )}

      {/* Bottom-positioned extra sections (default placement). Same as the
          top extras: independent of scale existence / disabled state. */}
      {bottomExtraSections.map((section) => (
        <Section
          key={section.id}
          title={section.title}
          defaultOpen={section.defaultOpen ?? false}
          icon={section.icon}
        >
          <div className={styles.sectionBody}>{section.render(group)}</div>
        </Section>
      ))}
    </div>
  )
}
