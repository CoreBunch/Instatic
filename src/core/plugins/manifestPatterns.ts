/**
 * Patterns shared by the manifest schema modules (`manifest.ts`,
 * `manifestFrontend.ts`).
 */

/** A package-relative file path: no leading slash, no `..` segment. */
export const SAFE_ASSET_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/
