import { Button } from '@ui/components/Button'
import { LOCALE_NATIVE_NAMES } from './catalog'
import { useI18n } from './context'

interface LanguageSwitcherProps {
  className?: string
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n()
  const nextLocale = locale === 'en' ? 'zh-CN' : 'en'
  const nextLocaleName = LOCALE_NATIVE_NAMES[nextLocale]

  return (
    <Button
      variant="ghost"
      size="xs"
      className={className}
      aria-label={t('language.switchTo', { language: nextLocaleName })}
      onClick={() => setLocale(nextLocale)}
    >
      {nextLocaleName}
    </Button>
  )
}
