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
  inputType: 'email' | 'password' | 'text' | 'hidden'
  autocomplete: string
  /**
   * A value the form sends without asking: the field is hidden and filled
   * from where the form sits (a token such as `{currentEntry.id}`).
   */
  value?: string
}

/** How the editor's action picker groups the actions. */
export type MemberFormGroup = 'entry' | 'emailLink' | 'account'

export const MEMBER_FORM_GROUP_LABELS: Record<MemberFormGroup, string> = {
  entry: 'Signing in and joining',
  emailLink: 'Pages an emailed link opens',
  account: 'For signed-in members',
}

export interface MemberFormAction {
  action: string
  label: string
  group: MemberFormGroup
  /** What the form does, for the editor. */
  description: string
  fields: readonly MemberFormField[]
  /**
   * The value the form posts back from its page's address. `token`: the page
   * was opened from an emailed link (`?token=`). `request`: an app sent the
   * member here to approve it (`?request=`). Null when the form carries none.
   */
  linkParam: 'token' | 'request' | null
  /** Only a signed-in member can use it. */
  signedIn: boolean
  submitLabel: string
  /**
   * A sensible message for a form that shows one instead of redirecting.
   * Empty when a success never shows one: signing out reloads the page or
   * moves on, and the form is gone with the member.
   */
  successMessage: string
  /**
   * The form asks a yes-or-no question, so it has two buttons and each one
   * carries its answer as the button's own `name` and `value`. The endpoint
   * refuses a post without the answer: a form whose button was not sent
   * (an old script, a stripped button) must never count as "yes".
   */
  choice?: { name: string; submitValue: string; other: { label: string; value: string } }
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
    group: 'entry',
    description: 'Creates an account and emails a link to confirm the address.',
    fields: [NAME, EMAIL, { ...PASSWORD, autocomplete: 'new-password' }],
    linkParam: null,
    signedIn: false,
    submitLabel: 'Create account',
    successMessage: 'Check your email to confirm your address.',
  },
  {
    action: 'login',
    label: 'Sign in',
    group: 'entry',
    description: 'Signs a member in with email and password.',
    fields: [EMAIL, PASSWORD],
    linkParam: null,
    signedIn: false,
    submitLabel: 'Sign in',
    successMessage: 'You are signed in.',
  },
  {
    action: 'link/request',
    label: 'Email a sign-in link',
    group: 'entry',
    description: 'Emails a link that signs the member in without a password.',
    fields: [EMAIL],
    linkParam: null,
    signedIn: false,
    submitLabel: 'Email me a link',
    successMessage: 'If that address has an account, a sign-in link is on its way.',
  },
  {
    action: 'password/forgot',
    label: 'Forgot password',
    group: 'entry',
    description: 'Emails a link to choose a new password.',
    fields: [EMAIL],
    linkParam: null,
    signedIn: false,
    submitLabel: 'Email me a reset link',
    successMessage: 'If that address has an account, a reset link is on its way.',
  },
  {
    action: 'password/reset',
    label: 'Choose a new password',
    group: 'emailLink',
    description: 'For the page a reset link opens: sets the new password and signs in.',
    fields: [NEW_PASSWORD],
    linkParam: 'token',
    signedIn: false,
    submitLabel: 'Save password',
    successMessage: 'Your password is changed.',
  },
  {
    action: 'invite/accept',
    label: 'Accept an invitation',
    group: 'emailLink',
    description: 'For the page an invitation link opens: sets a password and signs in.',
    fields: [NEW_PASSWORD],
    linkParam: 'token',
    signedIn: false,
    submitLabel: 'Create account',
    successMessage: 'Your account is ready.',
  },
  {
    action: 'verify',
    label: 'Confirm email address',
    group: 'emailLink',
    description: 'For the page a confirmation link opens: confirms the address and signs in.',
    fields: [],
    linkParam: 'token',
    signedIn: false,
    submitLabel: 'Confirm my address',
    successMessage: 'Your address is confirmed.',
  },
  {
    action: 'link/confirm',
    label: 'Finish signing in from a link',
    group: 'emailLink',
    description: 'For the page a sign-in link opens: signs the member in.',
    fields: [],
    linkParam: 'token',
    signedIn: false,
    submitLabel: 'Sign in',
    successMessage: 'You are signed in.',
  },
  {
    action: 'email/confirm',
    label: 'Confirm a new email address',
    group: 'emailLink',
    description: 'For the page an address-change link opens: switches to the new address.',
    fields: [],
    linkParam: 'token',
    signedIn: false,
    submitLabel: 'Confirm my new address',
    successMessage: 'Your address is changed.',
  },
  {
    action: 'profile',
    label: 'Update profile',
    group: 'account',
    description: 'Saves the signed-in member\'s profile fields.',
    fields: [NAME],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Save',
    successMessage: 'Saved.',
  },
  {
    action: 'password/change',
    label: 'Change password',
    group: 'account',
    description: 'Changes the signed-in member\'s password.',
    fields: [CURRENT_PASSWORD, { name: 'newPassword', label: 'New password', inputType: 'password', autocomplete: 'new-password' }],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Change password',
    successMessage: 'Your password is changed.',
  },
  {
    action: 'email/change',
    label: 'Change email address',
    group: 'account',
    description: 'Emails a confirmation link to the new address.',
    fields: [{ ...EMAIL, label: 'New email' }, CURRENT_PASSWORD],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Change email',
    successMessage: 'Check your new address for a confirmation link.',
  },
  {
    action: 'logout',
    label: 'Sign out',
    group: 'account',
    description: 'Signs the member out. The form needs only its button.',
    fields: [],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Sign out',
    successMessage: '',
  },
  {
    action: 'delete',
    label: 'Delete account',
    group: 'account',
    description: 'Deletes the signed-in member\'s account for good.',
    fields: [CURRENT_PASSWORD],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Delete my account',
    successMessage: 'Your account is deleted.',
  },
  {
    action: 'apps/approve',
    label: 'Approve an app',
    group: 'account',
    description: 'For the page an app sends a member to: Allow lets that app sign the member in, Cancel sends them back without.',
    fields: [],
    linkParam: 'request',
    signedIn: true,
    submitLabel: 'Allow',
    successMessage: 'The app is signed in. You can close this page.',
    choice: { name: 'decision', submitValue: 'allow', other: { label: 'Cancel', value: 'deny' } },
  },
  {
    action: 'apps/disconnect',
    label: 'Disconnect an app',
    group: 'account',
    description: 'For a list of the member\'s connected apps: signs that app out of the member\'s account. Put the form inside the list, one per app.',
    fields: [{ name: 'connection', label: 'The app to disconnect', inputType: 'hidden', autocomplete: 'off', value: '{currentEntry.id}' }],
    linkParam: null,
    signedIn: true,
    submitLabel: 'Disconnect',
    successMessage: 'The app is disconnected.',
  },
]

/**
 * The form a page needs to do its job in each Member settings slot. A page
 * without one still opens, and then does nothing. `afterLogin` is only a
 * place to land, so it needs none.
 */
export const MEMBER_PAGE_FORM_ACTIONS = {
  login: ['login', 'link/request'],
  afterLogin: [],
  verify: ['verify'],
  reset: ['password/reset'],
  magic: ['link/confirm'],
  invite: ['invite/accept'],
  emailChange: ['email/confirm'],
  appSignIn: ['apps/approve'],
} as const satisfies Record<string, readonly string[]>

export const DEFAULT_MEMBER_FORM_ACTION = 'login'

export function memberFormAction(action: string): MemberFormAction | undefined {
  return MEMBER_FORM_ACTIONS.find((candidate) => candidate.action === action)
}

/** Where a member form posts. Unknown actions fall back to sign-in, never to an arbitrary path. */
export function memberFormActionPath(action: string): string {
  return `/_instatic/members/${memberFormAction(action)?.action ?? DEFAULT_MEMBER_FORM_ACTION}`
}
