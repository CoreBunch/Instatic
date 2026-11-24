import type { MailTemplateVariable } from './schemas'

export interface MailTemplateDefinition {
  /** Stable id, also the `kind` recorded in the activity log. */
  key: string
  label: string
  /** When this email is sent, in a sentence. */
  description: string
  /** Heading the template is listed under in the admin. */
  group: string
  variables: readonly MailTemplateVariable[]
  defaultSubject: string
  defaultBody: string
}

/**
 * Variables every template can use. They carry no made-up sample: the server
 * fills `sample` with the site's real name and address when it hands a
 * template to the admin.
 */
export const COMMON_MAIL_VARIABLES: readonly MailTemplateVariable[] = [
  { name: 'site.name', label: 'Site name', sample: '' },
  { name: 'site.url', label: 'Site address', sample: '' },
]

const definitions = new Map<string, MailTemplateDefinition>()

/** Add a template to the catalogue. Features register theirs at module load. */
export function registerMailTemplate(definition: MailTemplateDefinition): void {
  definitions.set(definition.key, {
    ...definition,
    variables: [...definition.variables, ...COMMON_MAIL_VARIABLES],
  })
}

/** Take a template out of the catalogue: its feature (a plugin) is no longer loaded. */
export function unregisterMailTemplate(key: string): void {
  definitions.delete(key)
}

export function getMailTemplateDefinition(key: string): MailTemplateDefinition | undefined {
  return definitions.get(key)
}

export function listMailTemplateDefinitions(): MailTemplateDefinition[] {
  return [...definitions.values()]
}

export const TEST_MAIL_TEMPLATE_KEY = 'mail.test'

registerMailTemplate({
  key: TEST_MAIL_TEMPLATE_KEY,
  label: 'Test email',
  description: 'Sent when you press "Send test email" on a connector or a template.',
  group: 'General',
  variables: [],
  defaultSubject: 'Test email from {site.name}',
  defaultBody:
    'This is a test email from **{site.name}**.\n\nIf you are reading it, outgoing email works.',
})

export const ADMIN_INVITE_TEMPLATE_KEY = 'user.invite'

registerMailTemplate({
  key: ADMIN_INVITE_TEMPLATE_KEY,
  label: 'Admin user invitation',
  description: 'Sent when someone is invited to sign in to the admin.',
  group: 'Admin users',
  variables: [{ name: 'link', label: 'Invitation link', kind: 'link', sample: 'https://example.com/admin/invitation#invite=sample' }],
  defaultSubject: 'Your invitation to the {site.name} admin',
  defaultBody: 'Choose a password to access the **{site.name}** admin. This invitation works once and expires in 7 days.\n\n[Accept invitation]({link})',
})
