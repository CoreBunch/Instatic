/**
 * The member actions a form on a page can perform. One catalogue drives the
 * form module (which endpoint a form posts to), the editor (the action
 * picker, and the fields "Add the fields" inserts) and the docs.
 *
 * `action` is the path under `/_instatic/members/`.
 */

export interface MemberFormField {
  /** The field's `name`, as the endpoint reads it. */
  name: string
  label: string
  inputType: 'email' | 'password' | 'text'
  autocomplete: string
}

export interface MemberFormAction {
  action: string
  label: string
  /** What the form does, for the editor. */
  description: string
  fields: readonly MemberFormField[]
  /** The form sits on a page opened from an emailed link and posts its `?token=` back. */
  needsToken: boolean
  /** Only a signed-in member can use it. */
  signedIn: boolean
  submitLabel: string
  /** A sensible message for a form that shows one instead of redirecting. */
  successMessage: string
}

const EMAIL: MemberFormField = { name: 'email', label: 'Email', inputType: 'email', autocomplete: 'email' }
const PASSWORD: MemberFormField = { name: 'password', label: 'Password', inputType: 'password', autocomplete: 'current-password' }
const NEW_PASSWORD: MemberFormField = { name: 'password', label: 'New password', inputType: 'password', autocomplete: 'new-password' }
const CURRENT_PASSWORD: MemberFormField = { name: 'currentPassword', label: 'Current password', inputType: 'password', autocomplete: 'current-password' }
const NAME: MemberFormField = { name: 'name', label: 'Name', inputType: 'text', autocomplete: 'name' }

export const MEMBER_FORM_ACTIONS: readonly MemberFormAction[] = [
  {
    action: 'signup',
    label: 'Sign up',
    description: 'Creates an account and emails a link to confirm the address.',
    fields: [NAME, EMAIL, { ...PASSWORD, autocomplete: 'new-password' }],
    needsToken: false,
    signedIn: false,
    submitLabel: 'Create account',
    successMessage: 'Check your email to confirm your address.',
  },
  {
    action: 'login',
    label: 'Sign in',
    description: 'Signs a member in with email and password.',
    fields: [EMAIL, PASSWORD],
    needsToken: false,
    signedIn: false,
    submitLabel: 'Sign in',
    successMessage: 'You are signed in.',
  },
  {
    action: 'link/request',
    label: 'Email a sign-in link',
    description: 'Emails a link that signs the member in without a password.',
    fields: [EMAIL],
    needsToken: false,
    signedIn: false,
    submitLabel: 'Email me a link',
    successMessage: 'If that address has an account, a sign-in link is on its way.',
  },
  {
    action: 'logout',
    label: 'Sign out',
    description: 'Signs the member out. Needs only a button.',
    fields: [],
    needsToken: false,
    signedIn: true,
    submitLabel: 'Sign out',
    successMessage: 'You are signed out.',
  },
  {
    action: 'password/forgot',
    label: 'Forgot password',
    description: 'Emails a link to choose a new password.',
    fields: [EMAIL],
    needsToken: false,
    signedIn: false,
    submitLabel: 'Email me a reset link',
    successMessage: 'If that address has an account, a reset link is on its way.',
  },
  {
    action: 'password/reset',
    label: 'Choose a new password',
    description: 'For the page a reset link opens: sets the new password and signs in.',
    fields: [NEW_PASSWORD],
    needsToken: true,
    signedIn: false,
    submitLabel: 'Save password',
    successMessage: 'Your password is changed.',
  },
  {
    action: 'invite/accept',
    label: 'Accept an invitation',
    description: 'For the page an invitation link opens: sets a password and signs in.',
    fields: [NEW_PASSWORD],
    needsToken: true,
    signedIn: false,
    submitLabel: 'Create account',
    successMessage: 'Your account is ready.',
  },
  {
    action: 'verify',
    label: 'Confirm email address',
    description: 'For the page a confirmation link opens: confirms the address and signs in.',
    fields: [],
    needsToken: true,
    signedIn: false,
    submitLabel: 'Confirm my address',
    successMessage: 'Your address is confirmed.',
  },
  {
    action: 'link/confirm',
    label: 'Finish signing in from a link',
    description: 'For the page a sign-in link opens: signs the member in.',
    fields: [],
    needsToken: true,
    signedIn: false,
    submitLabel: 'Sign in',
    successMessage: 'You are signed in.',
  },
  {
    action: 'email/confirm',
    label: 'Confirm a new email address',
    description: 'For the page an address-change link opens: switches to the new address.',
    fields: [],
    needsToken: true,
    signedIn: false,
    submitLabel: 'Confirm my new address',
    successMessage: 'Your address is changed.',
  },
  {
    action: 'profile',
    label: 'Update profile',
    description: 'Saves the signed-in member\'s profile fields.',
    fields: [NAME],
    needsToken: false,
    signedIn: true,
    submitLabel: 'Save',
    successMessage: 'Saved.',
  },
  {
    action: 'password/change',
    label: 'Change password',
    description: 'Changes the signed-in member\'s password.',
    fields: [CURRENT_PASSWORD, { name: 'newPassword', label: 'New password', inputType: 'password', autocomplete: 'new-password' }],
    needsToken: false,
    signedIn: true,
    submitLabel: 'Change password',
    successMessage: 'Your password is changed.',
  },
  {
    action: 'email/change',
    label: 'Change email address',
    description: 'Emails a confirmation link to the new address.',
    fields: [{ ...EMAIL, label: 'New email' }, CURRENT_PASSWORD],
    needsToken: false,
    signedIn: true,
    submitLabel: 'Change email',
    successMessage: 'Check your new address for a confirmation link.',
  },
  {
    action: 'delete',
    label: 'Delete account',
    description: 'Deletes the signed-in member\'s account for good.',
    fields: [CURRENT_PASSWORD],
    needsToken: false,
    signedIn: true,
    submitLabel: 'Delete my account',
    successMessage: 'Your account is deleted.',
  },
]

export const DEFAULT_MEMBER_FORM_ACTION = 'login'

export function memberFormAction(action: string): MemberFormAction | undefined {
  return MEMBER_FORM_ACTIONS.find((candidate) => candidate.action === action)
}

/** Where a member form posts. Unknown actions fall back to sign-in, never to an arbitrary path. */
export function memberFormActionPath(action: string): string {
  return `/_instatic/members/${memberFormAction(action)?.action ?? DEFAULT_MEMBER_FORM_ACTION}`
}
