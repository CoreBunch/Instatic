import type { SiteDocument } from '@core/page-tree'
import { LanguageCatalogueSchema, type TranslationMessages } from '@core/localization-schema'
import { safeParseJson } from '@core/utils/jsonValidate'

export class LocalizationError extends Error {
  readonly path: string
  constructor(path: string, message: string, cause?: unknown) {
    super(`${path}: ${message}`, cause === undefined ? undefined : { cause })
    this.name = 'LocalizationError'
    this.path = path
  }
}

export function canonicalLanguage(language: string): string {
  try {
    const canonical = Intl.getCanonicalLocales(language.trim())[0]
    if (canonical) return canonical
  } catch (cause) {
    throw new LocalizationError('language', `Invalid language tag "${language}"`, cause)
  }
  throw new LocalizationError('language', 'A language tag is required')
}

export function translationKeys(messages: TranslationMessages, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new LocalizationError(path, 'Reserved dictionary key')
    }
    if (typeof value === 'string') {
      if (!value.trim()) throw new LocalizationError(`translations.${path}`, 'Translation text is empty')
      keys.push(path)
    }
    else keys.push(...translationKeys(value, path))
  }
  return keys.sort()
}

/** No fallback copy: a missing translation is an authoring error. */
export function resolveTranslation(
  messages: TranslationMessages | undefined,
  key: string,
  language: string,
): string {
  let value: string | TranslationMessages | undefined = messages
  for (const segment of key.split('.')) {
    if (!value || typeof value === 'string' || !Object.hasOwn(value, segment)) {
      throw new LocalizationError(`translations.${key}`, `Missing translation for "${language}"`)
    }
    value = value[segment]
  }
  if (typeof value !== 'string') {
    throw new LocalizationError(`translations.${key}`, 'A translation must resolve to text')
  }
  return value
}

type CatalogueInput = {
  language: string
  fileId: string
  path: string | undefined
  type: string | undefined
  content: string | undefined
}
const catalogueCache = new WeakMap<object, {
  inputs: CatalogueInput[]
  catalogues: Map<string, TranslationMessages>
}>()

/** Pure, shared by canvas and publication. Config files never ship as a runtime. */
export function resolveSiteLanguage(site: Pick<SiteDocument, 'settings' | 'files'>, pageLanguage?: string): {
  language: string
  translations?: TranslationMessages
} {
  const settings = site.settings.localization
  const authoredLanguage = pageLanguage ?? site.settings.language ?? 'en'
  if (!settings) return { language: authoredLanguage }
  const language = canonicalLanguage(authoredLanguage)
  const inputs = settings.catalogues.map((entry) => {
    const file = site.files.find((candidate) => candidate.id === entry.fileId)
    return { ...entry, path: file?.path, type: file?.type, content: file?.content }
  })
  const cached = catalogueCache.get(site.files)
  const unchanged = cached && inputs.length === cached.inputs.length && inputs.every((input, index) => {
    const previous = cached.inputs[index]
    return input.language === previous.language && input.fileId === previous.fileId &&
      input.path === previous.path && input.type === previous.type && input.content === previous.content
  })
  let catalogues = unchanged ? cached.catalogues : undefined
  if (!catalogues) {
    catalogues = new Map()
    let expectedKeys: string[] | undefined
    for (const entry of settings.catalogues) {
      const locale = canonicalLanguage(entry.language)
      if (catalogues.has(locale)) throw new LocalizationError('localization.catalogues', `Duplicate language "${locale}"`)
      const file = site.files.find((candidate) => candidate.id === entry.fileId)
      if (!file || file.type !== 'config' || file.content === undefined || !file.path.endsWith('.json')) {
        throw new LocalizationError(`files.${entry.fileId}`, 'Choose a JSON language file')
      }
      const parsed = safeParseJson(file.content, LanguageCatalogueSchema)
      if (!parsed.ok) throw new LocalizationError(file.path, 'Invalid language catalogue', parsed.error)
      const catalogue = parsed.value
      if (canonicalLanguage(catalogue.language) !== locale) {
        throw new LocalizationError(file.path, `Expected language "${locale}"`)
      }
      const keys = translationKeys(catalogue.messages)
      if (expectedKeys && JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        const missing = expectedKeys.filter((key) => !keys.includes(key))
        const extra = keys.filter((key) => !expectedKeys!.includes(key))
        throw new LocalizationError(file.path, `Translation keys differ (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
      }
      expectedKeys ??= keys
      catalogues.set(locale, catalogue.messages)
    }
    catalogueCache.set(site.files, { inputs, catalogues })
  }
  const translations = catalogues.get(language)
  if (!translations) throw new LocalizationError('page.language', `No language catalogue for "${language}"`)
  return { language, translations }
}
