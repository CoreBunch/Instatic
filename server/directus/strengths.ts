/**
 * Fixed strengths ("troeven") catalog — intake screen 21.
 *
 * A closed, server-owned list. Intake stores 3–6 ids on
 * `contentFacts.strengths`; labels are locale maps resolved at render time so
 * the words are never authored on the site.
 *
 * Static data: no Directus round-trip, so these reads work even when the
 * Directus reader is unconfigured.
 */
import {
  expandNames,
  resolveName,
  type DirectusTranslation,
  type LocaleNames,
  type SupportedLocale,
} from './locales'
import { optionalLocale, optionalNonEmpty } from './validate'
import { directusBadRequest } from './errors'

export interface StrengthRow {
  id: string
  icon: string
  /** All 8 supported locales, filled by the shared translation fallback. */
  names: LocaleNames
  /** Present only when a single `locale` was requested. */
  name?: string
}

interface StrengthSource {
  id: string
  icon: string
  names: Record<string, string>
}

const STRENGTH_SOURCES: readonly StrengthSource[] = [
  { id: 'owner-on-site', icon: 'hard-hat', names: { 'nl-BE': 'Zaakvoerder op de werf', 'fr-BE': 'Le patron sur le chantier', 'de-BE': 'Inhaber vor Ort', 'en-BE': 'Owner on site' } },
  { id: 'respect-deadlines', icon: 'calendar-check', names: { 'nl-BE': 'Respect voor deadlines', 'fr-BE': 'Respect des délais', 'de-BE': 'Termintreue', 'en-BE': 'Respect for deadlines' } },
  { id: 'careful-work', icon: 'sparkles', names: { 'nl-BE': 'Verzorgd werk', 'fr-BE': 'Travail soigné', 'de-BE': 'Sorgfältige Arbeit', 'en-BE': 'Careful work' } },
  { id: 'free-quote', icon: 'file-text', names: { 'nl-BE': 'Gratis offerte', 'fr-BE': 'Devis gratuit', 'de-BE': 'Kostenloses Angebot', 'en-BE': 'Free quote' } },
  { id: 'clean-sites', icon: 'brush-cleaning', names: { 'nl-BE': 'Nette werven', 'fr-BE': 'Chantiers propres', 'de-BE': 'Saubere Baustellen', 'en-BE': 'Clean sites' } },
  { id: 'availability', icon: 'message-circle-more', names: { 'nl-BE': 'Beschikbaarheid & reactiviteit', 'fr-BE': 'Disponibilité & réactivité', 'de-BE': 'Verfügbarkeit & Reaktivität', 'en-BE': 'Availability & responsiveness' } },
  { id: 'ten-year-guarantee', icon: 'shield-check', names: { 'nl-BE': 'Tienjarige garantie', 'fr-BE': 'Garantie décennale', 'de-BE': 'Zehnjahresgarantie', 'en-BE': 'Ten-year guarantee' } },
  { id: 'vca-certified', icon: 'badge-check', names: { 'nl-BE': 'VCA-gecertificeerd', 'fr-BE': 'Certifié VCA', 'de-BE': 'VCA-zertifiziert', 'en-BE': 'VCA certified' } },
  { id: 'ten-years-plus', icon: 'award', names: { 'nl-BE': 'Meer dan 10 jaar ervaring', 'fr-BE': "Plus de 10 ans d'expérience", 'de-BE': 'Mehr als 10 Jahre Erfahrung', 'en-BE': 'More than 10 years of experience' } },
  { id: 'family-business', icon: 'house-heart', names: { 'nl-BE': 'Familiebedrijf', 'fr-BE': 'Entreprise familiale', 'de-BE': 'Familienbetrieb', 'en-BE': 'Family business' } },
  { id: 'custom-work', icon: 'ruler', names: { 'nl-BE': 'Maatwerk', 'fr-BE': 'Sur mesure', 'de-BE': 'Maßarbeit', 'en-BE': 'Custom work' } },
  { id: 'quality-materials', icon: 'gem', names: { 'nl-BE': 'Kwaliteitsmaterialen', 'fr-BE': 'Matériaux de qualité', 'de-BE': 'Qualitätsmaterialien', 'en-BE': 'Quality materials' } },
  { id: 'personal-advice', icon: 'handshake', names: { 'nl-BE': 'Persoonlijk advies', 'fr-BE': 'Conseil personnalisé', 'de-BE': 'Persönliche Beratung', 'en-BE': 'Personal advice' } },
  { id: 'transparent-prices', icon: 'tag', names: { 'nl-BE': 'Transparante prijzen', 'fr-BE': 'Prix transparents', 'de-BE': 'Transparente Preise', 'en-BE': 'Transparent prices' } },
  { id: 'fast-response', icon: 'zap', names: { 'nl-BE': 'Snelle interventie', 'fr-BE': 'Intervention rapide', 'de-BE': 'Schneller Einsatz', 'en-BE': 'Fast response' } },
  { id: 'respect-budget', icon: 'wallet', names: { 'nl-BE': 'Respect voor het budget', 'fr-BE': 'Respect du budget', 'de-BE': 'Budgettreue', 'en-BE': 'Respect for the budget' } },
  { id: 'professional-team', icon: 'users-round', names: { 'nl-BE': 'Professioneel team', 'fr-BE': 'Équipe professionnelle', 'de-BE': 'Professionelles Team', 'en-BE': 'Professional team' } },
  { id: 'local-sites', icon: 'map-pin', names: { 'nl-BE': 'Lokale werven', 'fr-BE': 'Chantiers locaux', 'de-BE': 'Lokale Baustellen', 'en-BE': 'Local sites' } },
  { id: 'satisfaction-guaranteed', icon: 'smile', names: { 'nl-BE': 'Tevredenheid gegarandeerd', 'fr-BE': 'Satisfaction garantie', 'de-BE': 'Zufriedenheit garantiert', 'en-BE': 'Satisfaction guaranteed' } },
  { id: 'after-sales', icon: 'headset', names: { 'nl-BE': 'Dienst na verkoop', 'fr-BE': 'Service après-vente', 'de-BE': 'After-Sales-Service', 'en-BE': 'After-sales service' } },
] as const

/** Every valid `contentFacts.strengths` id, in intake order. */
export const STRENGTH_IDS = STRENGTH_SOURCES.map((row) => row.id) as readonly string[]

const STRENGTH_ID_SET: ReadonlySet<string> = new Set(STRENGTH_IDS)

export function isStrengthId(value: string): boolean {
  return STRENGTH_ID_SET.has(value)
}

function translationsOf(names: Record<string, string>): DirectusTranslation[] {
  return Object.entries(names).map(([languagesCode, name]) => ({
    languagesCode,
    name,
    fields: { name },
  }))
}

/** Authored BE labels expanded to all 8 supported locales via the shared fallback. */
const STRENGTHS: readonly StrengthRow[] = STRENGTH_SOURCES.map((source) => ({
  id: source.id,
  icon: source.icon,
  names: expandNames(translationsOf(source.names), 'BE'),
}))

const STRENGTH_BY_ID = new Map(STRENGTHS.map((row) => [row.id, row]))

/** `names` is already all-8; the shared fallback chain still fills a blank entry. */
function resolveStrengthName(row: StrengthRow, locale: SupportedLocale): string {
  const translations: DirectusTranslation[] = Object.entries(row.names).map(([code, name]) => ({
    languagesCode: code,
    name,
    fields: { name },
  }))
  return resolveName(translations, locale, 'BE')
}

export interface StrengthListQuery {
  /** Resolve one locale into `name`. Omit for the full `names` map only. */
  locale?: SupportedLocale
  /** Restrict to these ids, in catalog order. Unknown ids are a 400. */
  ids?: string[]
}

export function parseStrengthListQuery(params: URLSearchParams): StrengthListQuery {
  const locale = optionalLocale(params.get('locale'))
  const rawIds = optionalNonEmpty('ids', params.get('ids'))
  const ids = rawIds?.split(',').map((id) => id.trim()).filter(Boolean)
  return { locale, ids: ids?.length ? ids : undefined }
}

export function listStrengths(query: StrengthListQuery = {}): { data: StrengthRow[]; count: number } {
  let rows: readonly StrengthRow[] = STRENGTHS
  if (query.ids) {
    const wanted = new Set(query.ids)
    for (const id of wanted) {
      if (!STRENGTH_BY_ID.has(id)) throw directusBadRequest(`Unknown strength id '${id}'`)
    }
    rows = STRENGTHS.filter((row) => wanted.has(row.id))
  }
  const locale = query.locale
  const data = locale
    ? rows.map((row) => ({ ...row, name: resolveStrengthName(row, locale) }))
    : rows.map((row) => ({ ...row }))
  return { data, count: data.length }
}
