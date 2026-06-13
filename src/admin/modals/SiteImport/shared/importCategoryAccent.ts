import { assignRailAccents, railTintVar, type RailAccent } from '@ui/railAccent'
import type { ImportCategoryId } from './importProgress'

interface SiteImportCategoryIdentity {
  id: ImportCategoryId
  label: string
}

type SiteImportCategoryTint<TCategory> = TCategory & {
  accent: RailAccent
  tint: string
}

export function withSiteImportCategoryTints<TCategory extends SiteImportCategoryIdentity>(
  categories: readonly TCategory[],
): SiteImportCategoryTint<TCategory>[] {
  const accents = assignRailAccents(
    categories,
    (category) => `site-import:${category.id}:${category.label}`,
  )

  return categories.map((category, index) => {
    const accent = accents[index] ?? 'mint'
    return {
      ...category,
      accent,
      tint: railTintVar(accent),
    }
  })
}
