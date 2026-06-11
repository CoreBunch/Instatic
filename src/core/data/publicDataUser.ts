/**
 * Public-facing user reference attached to published data rows.
 *
 * Strips internal-only ids and email addresses, retaining only the bits the
 * publisher and frontend templates need to render bylines safely.
 */

interface PublicDataUserReference {
  displayName: string
  roleSlug: string | null
  roleName: string | null
}

interface DataUserLike {
  displayName: string | null
  roleSlug?: string | null
  roleName?: string | null
}

function publicDataUserReference(
  user: DataUserLike | null | undefined,
): PublicDataUserReference | null {
  if (!user) return null
  const displayName = user.displayName?.trim()
  if (!displayName) return null
  return {
    displayName,
    roleSlug: user.roleSlug ?? null,
    roleName: user.roleName ?? null,
  }
}

export function publicDataUserFromParts(
  displayName: string | null | undefined,
  roleSlug: string | null | undefined,
  roleName: string | null | undefined,
): PublicDataUserReference | null {
  return publicDataUserReference({
    displayName: displayName ?? null,
    roleSlug: roleSlug ?? null,
    roleName: roleName ?? null,
  })
}
