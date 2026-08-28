/**
 * EffectAddMenu — the "+" in the Effects header (inspector-panel.md §7.6).
 *
 * Unlike every other section's "+", this one adds an EFFECT, not a CSS
 * property, so it lists the effect catalogue instead of property names: a
 * plain list, no search box (four entries need no filter). An effect already
 * on the element is listed, dimmed and ticked, exactly like a used property
 * in the property menu — the two menus disagree on what they add, never on
 * how they behave.
 *
 * Picking one writes a visible starter value, so the row it creates is set
 * and immediately editable.
 */

import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { CheckGlyph } from '@ui/icons/inspectorGlyphs'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  EFFECT_KINDS,
  EFFECT_LABELS,
  formatShadowList,
  NEW_BLUR,
  NEW_SHADOW,
  parseShadowList,
  readEffects,
  writeBlur,
  type EffectKind,
} from './effectsModel'
import styles from './SectionAddMenu.module.css'

interface EffectAddMenuProps {
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function EffectAddMenu({ storedStyles, onChange }: EffectAddMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // "Used" is read from the element's live effects, so it cannot drift from
  // what the rows below show.
  const used = new Set<EffectKind>(readEffects(storedStyles).map((effect) => effect.kind))

  function addEffect(kind: EffectKind) {
    if (kind === 'dropShadow' || kind === 'innerShadow') {
      // A new shadow joins the list; the existing entries are re-emitted
      // untouched rather than replaced by the new one.
      const list = parseShadowList(storedStyles.boxShadow)
      list.push({ ...NEW_SHADOW, inset: kind === 'innerShadow' })
      onChange('boxShadow', formatShadowList(list))
    } else {
      const property = kind === 'layerBlur' ? 'filter' : 'backdropFilter'
      onChange(property, writeBlur(storedStyles[property], NEW_BLUR))
    }
    setOpen(false)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="micro"
        iconOnly
        className={styles.addButton}
        aria-label="Add effect"
        aria-haspopup="menu"
        aria-expanded={open}
        tooltip="Add effect"
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon size={12} color="currentColor" />
      </Button>
      {open && (
        <ContextMenu
          ariaLabel="Effects"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          width={176}
          menuClassName={styles.menu}
          onClose={() => setOpen(false)}
        >
          {EFFECT_KINDS.map((kind) => {
            const isUsed = used.has(kind)
            return (
              <ContextMenuItem
                key={kind}
                disabled={isUsed}
                className={isUsed ? styles.itemUsed : undefined}
                onClick={() => addEffect(kind)}
              >
                <span className={styles.itemRow}>
                  <span className={styles.itemLabel}>{EFFECT_LABELS[kind]}</span>
                  {isUsed && (
                    <span className={styles.itemTick}>
                      <CheckGlyph />
                    </span>
                  )}
                </span>
              </ContextMenuItem>
            )
          })}
        </ContextMenu>
      )}
    </>
  )
}
