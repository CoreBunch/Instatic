import { CodeIcon } from 'pixel-art-icons/icons/code'
import type { ProviderId } from './providerCatalog'
import { cn } from '@ui/cn'
import styles from './AiPage.module.css'

const LOGO_CLASS: Partial<Record<ProviderId, string>> = {
  anthropic: styles.logoAnthropic,
  openai: styles.logoOpenai,
  openrouter: styles.logoOpenrouter,
  ollama: styles.logoOllama,
}

export function ProviderMark({
  providerId,
  size = 'md',
}: {
  providerId: ProviderId
  size?: 'sm' | 'md' | 'lg'
}) {
  const logoClass = LOGO_CLASS[providerId]

  return (
    <span
      className={styles.providerMark}
      data-provider={providerId}
      data-size={size}
      aria-hidden="true"
    >
      {logoClass ? (
        <span className={cn(styles.providerLogo, logoClass)} />
      ) : (
        <CodeIcon size={size === 'lg' ? 22 : size === 'md' ? 18 : 14} />
      )}
    </span>
  )
}
