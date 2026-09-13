/**
 * The one password-length rule, shared by every surface that sets a
 * password: CMS setup, PATCH /me password change, the users admin API,
 * and the pre-auth setup form.
 */
export const MIN_PASSWORD_LENGTH = 12

export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
