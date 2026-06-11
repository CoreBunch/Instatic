/**
 * nameValidation — Visual Component name safety checks.
 *
 * Components are stored entities (rows in the site document), not generated
 * source files, so their names are free-form labels. The only invariants
 * enforced here are the ones required by the data model itself:
 *
 *   1. Name must not be empty / whitespace-only.
 *   2. Name must be unique within the site (selfId skips own entry on rename).
 *      Uniqueness is judged on the DERIVED SLUG, not the raw string — names
 *      are stored as `data_rows.slug` via `vcSlugFromName`, which lowercases
 *      and strips symbols, so "Button" and "button" are the same identity
 *      (`data_rows_table_slug_active_idx` would reject the second row).
 *
 * Param names follow the same logic at validateParamName():
 *   1. Name must not be empty.
 *   2. Name must be unique within the param surface (selfId skips own).
 *
 * Constraint #269: This file must NOT import from editor/ or editor-store/.
 */

/**
 * Derive the storage slug from a Visual Component name.
 * Converts to lower-kebab-case; falls back to 'component' on empty input.
 */
export function vcSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
  return slug || 'component'
}

// ---------------------------------------------------------------------------
// NameError codes — one per failure reason
// ---------------------------------------------------------------------------

type NameError =
  | 'EMPTY'
  | 'PROJECT_DUPLICATE'

// ---------------------------------------------------------------------------
// ParamError codes — for validateParamName()
// ---------------------------------------------------------------------------

type ParamError =
  | 'EMPTY'
  | 'DUPLICATE'

// ---------------------------------------------------------------------------
// validateComponentName
// ---------------------------------------------------------------------------

/**
 * Validate a proposed Visual Component name.
 *
 * @param name       - The proposed name string.
 * @param existing   - All existing VCs in the site (for uniqueness check).
 * @param selfId     - When renaming, pass the VC's own id to skip it in the
 *                     duplicate check (prevents false PROJECT_DUPLICATE on
 *                     renaming a VC to its current name).
 *
 * @returns `{ok: true}` on success, or `{ok: false, error, reason}` on failure.
 */
export function validateComponentName(
  name: string,
  existing: Array<{ id: string; name: string }>,
  selfId?: string,
): { ok: true } | { ok: false; error: NameError; reason: string } {
  // Rule 1 — must not be empty / whitespace-only
  if (!name || name.trim().length === 0) {
    return {
      ok: false,
      error: 'EMPTY',
      reason: 'Component name is required.',
    }
  }

  const trimmed = name.trim()

  // Rule 2 — must be unique within the site (skip own entry on rename via
  // selfId). Identity is the derived storage slug, not the raw string.
  const slug = vcSlugFromName(trimmed)
  const duplicate = existing.find((vc) => vc.id !== selfId && vcSlugFromName(vc.name) === slug)
  if (duplicate) {
    return {
      ok: false,
      error: 'PROJECT_DUPLICATE',
      reason: duplicate.name === trimmed
        ? `Another component is already named "${trimmed}".`
        : `"${trimmed}" conflicts with the existing component "${duplicate.name}" — both store as "${slug}".`,
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// validateParamName
// ---------------------------------------------------------------------------

/**
 * Validate a proposed Visual Component param name.
 *
 * Rules:
 *  1. Must not be empty / whitespace-only.
 *  2. Must be unique within the VC's existing params.
 *
 * @param name          - The proposed param name string.
 * @param existingParams - All params currently on the VC (for uniqueness check).
 * @param selfId        - When renaming, pass the param's own id to skip it in
 *                        the duplicate check.
 *
 * @returns `{ok: true}` on success, or `{ok: false, error, reason}` on failure.
 */
export function validateParamName(
  name: string,
  existingParams: Array<{ id: string; name: string }>,
  selfId?: string,
): { ok: true } | { ok: false; error: ParamError; reason: string } {
  // Rule 1 — must not be empty
  if (!name || name.trim().length === 0) {
    return {
      ok: false,
      error: 'EMPTY',
      reason: 'Param name is required.',
    }
  }

  const trimmed = name.trim()

  // Rule 2 — must be unique within the VC's params (skip self on rename)
  const duplicate = existingParams.find((p) => p.id !== selfId && p.name === trimmed)
  if (duplicate) {
    return {
      ok: false,
      error: 'DUPLICATE',
      reason: `Another param is already named "${trimmed}".`,
    }
  }

  return { ok: true }
}
