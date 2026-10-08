import type { Page, SiteDocument } from '@core/page-tree'
import { PageTranslationError, pagePublicPath, parsePageTranslationGroup } from '@core/page-tree'
import { canonicalLanguage } from '@core/localization'
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const PageTranslationSchema = Type.Object({
  id: Type.String(),
  language: Type.String(),
  title: Type.String(),
  permalink: Type.String(),
  current: Type.Boolean(),
  ariaCurrent: Type.Union([Type.Literal('page'), Type.Literal('false')]),
})
export type PageTranslation = Static<typeof PageTranslationSchema>
export const PageTranslationsSchema = Type.Record(Type.String(), PageTranslationSchema)

/** The page roster is the only route authority. No catalogue or runtime URL map. */
export function assertPageTranslationGroups(site: SiteDocument): void {
  const groups = new Map<string, Set<string>>()
  for (const page of site.pages) {
    const path = `pages.${page.id}.translationGroup`
    const group = parsePageTranslationGroup(page.translationGroup, path)
    if (!group) continue
    if (page.template?.enabled) throw new PageTranslationError(path, 'Translation groups belong to ordinary pages, not route templates')
    if (!page.language) throw new PageTranslationError(`pages.${page.id}.language`, 'A translated page must declare its language explicitly')
    const language = canonicalLanguage(page.language)
    const languages = groups.get(group) ?? new Set<string>()
    if (languages.has(language)) throw new PageTranslationError(path, `Group "${group}" contains more than one page in "${language}"`)
    languages.add(language)
    groups.set(group, languages)
  }
}

export function resolvePageTranslations(page: Page, site: SiteDocument): Record<string, PageTranslation> {
  if (!page.translationGroup) return {}
  assertPageTranslationGroups(site)
  const currentLanguage = page.language ? canonicalLanguage(page.language) : undefined
  const translations: Record<string, PageTranslation> = {}
  for (const candidate of site.pages) {
    if (candidate.translationGroup !== page.translationGroup) continue
    const language = canonicalLanguage(candidate.language!)
    const current = language === currentLanguage
    translations[language] = {
      id: candidate.id, language, title: candidate.title,
      permalink: pagePublicPath(candidate.slug), current,
      ariaCurrent: current ? 'page' : 'false',
    }
  }
  return translations
}

/** Missing authored destinations are errors, including bindings with fallback text. */
export function readPageTranslationField(translations: Record<string, PageTranslation> | undefined, field: string): unknown {
  const [language, property, ...rest] = field.split('.')
  const translation = translations && language && Object.hasOwn(translations, language)
    ? translations[language]
    : undefined
  if (!translation || !property || rest.length || !Object.hasOwn(translation, property)) {
    throw new PageTranslationError(`page.translations.${field}`, 'No translated page or field exists for this binding')
  }
  return translation[property as keyof PageTranslation]
}
