import { Fragment } from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import type { LanguageSwitcherProps } from './props'

/** Configured labels stay editable even before a translation is published. */
export function LanguageSwitcherEditor({ props, locales, localeId, mcClassName, nodeWrapperProps }: ModuleComponentProps<LanguageSwitcherProps>) {
  const options = locales?.filter((locale) => locale.enabled && (props.showCurrent || locale.id !== localeId)) ?? []
  if (options.length === 0) return <CanvasModulePlaceholder {...nodeWrapperProps} className={mcClassName}
    icon={<GlobeSolidIcon size={16} color="currentColor" />} label="Language switcher" />
  return <nav {...nodeWrapperProps} className={mcClassName} aria-label={props.label}>
    {options.map((locale, index) => <Fragment key={locale.id}>
      {index > 0 ? ' ' : null}
      <span lang={locale.code} aria-current={locale.id === localeId ? 'page' : undefined}>
        {props.display === 'code' ? locale.code : locale.name}
      </span>
    </Fragment>)}
  </nav>
}
