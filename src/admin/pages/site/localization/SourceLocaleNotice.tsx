import { Button } from '@ui/components/Button'
import { useEditorLocale } from './useEditorLocale'
import styles from './SourceLocaleNotice.module.css'

export function SourceLocaleNotice() {
  const { source, isTranslation, setActiveLocaleId } = useEditorLocale()
  if (!source || !isTranslation) return null
  return <div className={styles.notice}>
    <p>Structure, styles and site settings are shared. Edit them in {source.name}.</p>
    <Button variant="ghost" size="xs" onClick={() => setActiveLocaleId(source.id)}>Switch to {source.name}</Button>
  </div>
}
