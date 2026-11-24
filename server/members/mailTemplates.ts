/**
 * The emails members receive, as templates in the Email workspace. Each has
 * built-in wording here; an owner can reword any of them under
 * Email → Templates.
 *
 * `{link}` is the single-use address the email exists to deliver. It is
 * always built by the server from the configured public origin.
 */
import { registerMailTemplate, type MailTemplateVariable } from '@core/mail'

const GROUP = 'Members'

const EMAIL: MailTemplateVariable = { name: 'member.email', label: 'Member’s email address', sample: 'ada@example.com' }
const link = (path: string): MailTemplateVariable => ({
  name: 'link',
  label: 'The link this email delivers',
  sample: `https://example.com/${path}?token=sample`,
  kind: 'link',
})

const PASTE = 'If the link does not open, paste this address into your browser:\n\n{link}'
const IGNORE = 'If you did not ask for this, you can ignore this email.'

export const MEMBER_MAIL_KEYS = {
  verify: 'member.verify',
  already_registered: 'member.already_registered',
  reset: 'member.reset',
  magic: 'member.magic',
  invite: 'member.invite',
  email_change: 'member.email_change',
  email_change_notice: 'member.email_change_notice',
  password_changed: 'member.password_changed',
  app_connected: 'member.app_connected',
  app_pair: 'member.app_pair',
} as const

export type MemberMailKind = keyof typeof MEMBER_MAIL_KEYS

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.verify,
  label: 'Confirm email address',
  description: 'Sent when someone signs up, to prove the address is theirs.',
  group: GROUP,
  variables: [link('confirm'), EMAIL],
  defaultSubject: 'Confirm your email address for {site.name}',
  defaultBody:
    'Confirm your email address to finish creating your account at **{site.name}**.\n\n' +
    '[Confirm my address]({link})\n\n' +
    `This link works once and expires in 24 hours. ${PASTE}\n\n${IGNORE}`,
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.already_registered,
  label: 'Already have an account',
  description: 'Sent instead of a confirmation when someone signs up with an address that already has an account.',
  group: GROUP,
  variables: [EMAIL],
  defaultSubject: 'You already have an account at {site.name}',
  defaultBody:
    'Someone tried to create an account at **{site.name}** with this email address, but one already exists.\n\n' +
    'If that was you, sign in instead, or reset your password if you have forgotten it.\n\n' +
    'If it was not you, you can ignore this email. Nothing has changed.',
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.reset,
  label: 'Reset password',
  description: 'Sent when a member asks to reset their password.',
  group: GROUP,
  variables: [link('reset'), EMAIL],
  defaultSubject: 'Reset your password for {site.name}',
  defaultBody:
    'Use the link below to choose a new password for your account at **{site.name}**.\n\n' +
    '[Choose a new password]({link})\n\n' +
    `This link works once and expires in 1 hour. ${PASTE}\n\n${IGNORE}`,
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.magic,
  label: 'Sign-in link',
  description: 'Sent when a member asks for a link to sign in without a password.',
  group: GROUP,
  variables: [link('sign-in'), EMAIL],
  defaultSubject: 'Your sign-in link for {site.name}',
  defaultBody:
    'Use the link below to sign in to **{site.name}**.\n\n' +
    '[Sign in]({link})\n\n' +
    `This link works once and expires in 15 minutes. ${PASTE}\n\n${IGNORE}`,
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.invite,
  label: 'Invitation',
  description: 'Sent when you invite someone to become a member.',
  group: GROUP,
  variables: [link('invite'), EMAIL],
  defaultSubject: 'You have been invited to {site.name}',
  defaultBody:
    'You have been invited to create an account at **{site.name}**.\n\n' +
    '[Create my account]({link})\n\n' +
    `This link works once and expires in 7 days. ${PASTE}`,
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.email_change,
  label: 'Confirm new email address',
  description: 'Sent to the new address when a member changes their email.',
  group: GROUP,
  variables: [link('confirm-email'), EMAIL],
  defaultSubject: 'Confirm your new email address for {site.name}',
  defaultBody:
    'Confirm this address to use it for your account at **{site.name}**.\n\n' +
    '[Confirm my new address]({link})\n\n' +
    `This link works once and expires in 1 hour. ${PASTE}\n\n${IGNORE}`,
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.email_change_notice,
  label: 'Email change requested',
  description: 'Sent to the current address when a change of email is requested.',
  group: GROUP,
  variables: [EMAIL],
  defaultSubject: 'A change to your email address was requested',
  defaultBody:
    'Someone signed in to your account at **{site.name}** asked to change its email address.\n\n' +
    'If that was not you, change your password now.',
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.password_changed,
  label: 'Password changed',
  description: 'Sent after a member’s password is changed or reset.',
  group: GROUP,
  variables: [EMAIL],
  defaultSubject: 'Your password for {site.name} was changed',
  defaultBody:
    'The password for your account at **{site.name}** was just changed.\n\n' +
    'If that was not you, reset your password now.',
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.app_connected,
  label: 'App signed in',
  description: 'Sent after a member allows an app to sign in with their account.',
  group: GROUP,
  variables: [{ name: 'app.name', label: 'The app that was signed in', sample: 'Desktop app' }, EMAIL],
  defaultSubject: '{app.name} was signed in to your {site.name} account',
  defaultBody:
    '**{app.name}** was just signed in to your account at **{site.name}**.\n\n' +
    'If that was you, there is nothing to do.\n\n' +
    'If it was not, change your password now. That signs every app out of your account.',
})

registerMailTemplate({
  key: MEMBER_MAIL_KEYS.app_pair,
  label: 'Approve an app',
  description: 'Sent when a member requests email confirmation for an app connection.',
  group: GROUP,
  variables: [link('approve'), EMAIL, { name: 'app.name', label: 'App name', sample: 'Desktop' }],
  defaultSubject: 'Review your {app.name} connection',
  defaultBody: 'Review the request to connect **{app.name}** to your account. Check that the code matches the one in your app before allowing access. If you didn’t start this request, you can ignore this email.\n\n[Review app connection]({link})',
})
