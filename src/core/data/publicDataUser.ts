/**
 * Public-facing user reference attached to published data rows.
 *
 * Drops internal-only ids and the `email` field, retaining only the bits the
 * publisher and frontend templates need to render bylines.
 *
 * It does NOT guarantee the result is free of email addresses: `displayName`
 * carries whatever the account has set, and setup used to default that to the
 * address. Two things keep it out of public HTML now — a display name is empty
 * until someone sets one (`createUser`), and the binding frames expose the
 * display name as a leaf string rather than this object, because a non-scalar
 * binding used to be serialised wholesale into the page.
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
