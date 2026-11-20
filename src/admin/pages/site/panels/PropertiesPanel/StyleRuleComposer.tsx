import { useEffect } from 'react'
import type { CSSPropertyBag, StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { ruleStyleTarget, selectStyleConditionId, selectStyleContextId } from '@site/store/useActiveStyleTarget'
import { StyleSectionsEditor } from './StyleSectionsEditor'

interface StyleRuleComposerProps {
  cls: StyleRule
  textElement?: boolean
  styleQuery: string
}

export function StyleRuleComposer({ cls, textElement, styleQuery }: StyleRuleComposerProps) {
  const contextId = useEditorStore(selectStyleContextId)
  const conditionId = useEditorStore(selectStyleConditionId)
  const target = ruleStyleTarget(cls, contextId)
  const classId = cls.id
  useEffect(() => () => useEditorStore.getState().clearPreviewClassStyles(classId), [classId, contextId])

  function change(key: keyof CSSPropertyBag, value: string | number | undefined) {
    target.writeStyles({ [key]: value })
  }

  // Clear switcher dependencies together. A custom condition owns its own overrides.
  function clearProperties(keys: ReadonlyArray<keyof CSSPropertyBag>) {
    if (conditionId) target.writeStyles(Object.fromEntries(keys.map((key) => [key, undefined])))
    else useEditorStore.getState().clearClassStyleProperties(classId, keys)
  }

  return (
    <StyleSectionsEditor
      textElement={textElement}
      storedStyles={target.stored}
      currentStyles={target.styles}
      sectionKey={contextId ?? 'base'}
      styleQuery={styleQuery}
      onChange={change}
      onChangeMany={target.writeStyles}
      onRemove={(key) => change(key, undefined)}
      onClearProperty={(key) => clearProperties([key])}
      onClearProperties={clearProperties}
      onPreview={target.previewStyles}
      onClearPreview={target.clearPreview}
    />
  )
}
