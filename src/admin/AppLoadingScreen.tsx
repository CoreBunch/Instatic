import styles from './AppLoadingScreen.module.css'
import { useI18n } from './i18n'

export function AppLoadingScreen() {
  const { t } = useI18n()

  return (
    <div
      className={styles.screen}
      role="status"
      aria-busy="true"
      aria-label={t('app.loading')}
    >
      <BanterLoader />
    </div>
  )
}

function BanterLoader() {
  return (
    <div
      className={styles.banterLoader}
      data-loader-spinner="true"
      aria-hidden="true"
    >
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
      <div className={styles.banterBox} />
    </div>
  )
}
