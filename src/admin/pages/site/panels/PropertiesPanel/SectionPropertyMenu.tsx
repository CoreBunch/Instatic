import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { cssPropertyLabel, getCSSPropertyDefaultValue } from './cssControlTypes'
import { EFFECT_KINDS, EFFECT_LABELS, NEW_BLUR, NEW_SHADOW, changeShadow, readBlur, writeBlur } from './effectsModel'
import { hasStyleValue } from './styleValueUtils'

interface SectionPropertyMenuProps {
  sectionTitle: string
  properties: ReadonlyArray<keyof CSSPropertyBag>
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  onAdd: (property: keyof CSSPropertyBag, value: string | number) => void
}

export function SectionPropertyMenu({ sectionTitle, properties, currentStyles, storedStyles, onAdd }: SectionPropertyMenuProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const available = properties.filter((prop) => !hasStyleValue(storedStyles[prop]))
  const label = `Add ${sectionTitle.toLowerCase()} property`
  return (
    <>
      <Button
        ref={trigger}
        size="xs"
        variant="ghost"
        iconOnly
        aria-label={label}
        tooltip={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={available.length === 0 && sectionTitle !== 'Effects'}
        onClick={() => setOpen(!open)}
      >
        <PlusIcon size={14} />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={trigger}
          triggerRef={trigger}
          align="end"
          ariaLabel={`${sectionTitle} properties`}
          onClose={() => setOpen(false)}
        >
          {sectionTitle === 'Effects' && EFFECT_KINDS.map((kind) => {
            const shadow = kind === 'dropShadow' || kind === 'innerShadow'
            const prop = shadow ? 'boxShadow' : kind === 'layerBlur' ? 'filter' : 'backdropFilter'
            return (
              <ContextMenuItem key={kind} disabled={!shadow && readBlur(currentStyles[prop]) !== null}
                onClick={() => {
                  const value = shadow
                    ? changeShadow(currentStyles[prop], null, { ...NEW_SHADOW, inset: kind === 'innerShadow' })
                    : writeBlur(currentStyles[prop], NEW_BLUR)
                  if (value) onAdd(prop, value)
                  setOpen(false)
                }}>
                {EFFECT_LABELS[kind]}
              </ContextMenuItem>
            )
          })}
          {available.map((prop) => (
            <ContextMenuItem key={prop} onClick={() => {
              const inherited = currentStyles[prop]
              onAdd(prop, hasStyleValue(inherited) ? inherited : getCSSPropertyDefaultValue(prop))
              setOpen(false)
            }}>
              {cssPropertyLabel(prop)}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
