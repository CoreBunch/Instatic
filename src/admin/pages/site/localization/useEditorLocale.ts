import { useEditorStore } from '@site/store/store'

/** Authoring context, separate from the user's permanent capabilities. */
export function useEditorLocale() {
  const source = useEditorStore((state) => state.site?.locales?.find((locale) => locale.isDefault))
  const localeId = useEditorStore((state) => state.activeLocaleId ?? state.site?.localeId)
  const setActiveLocaleId = useEditorStore((state) => state.setActiveLocaleId)
  return { source, localeId, isTranslation: Boolean(source && localeId && source.id !== localeId), setActiveLocaleId }
}
