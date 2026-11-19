/**
 * The manifest's `mail` block: the email templates a plugin declares
 * (`mail.templates[]`). A declared template is listed in Email → Templates,
 * where the owner can reword it, and is the only thing the plugin can send:
 * there is no free-form subject or body.
 *
 * Shared by the manifest parser, the host (which registers the templates
 * while the plugin is loaded) and the lint CLI.
 */

import { mailValueProblem, MailRendererUnavailableError, renderMailTemplate } from '@core/mail'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'
import type { MailTemplateDefinition } from '@core/mail'

/** A template's name within its plugin. */
const MAIL_TEMPLATE_KEY_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
/** A variable name: what goes between the braces. `site.*` is the host's. */
const MAIL_VARIABLE_NAME_PATTERN = '^[a-z][a-zA-Z0-9]*(?:\\.[a-zA-Z0-9]+)*$'
const SINGLE_LINE = '^[^\\r\\n]*$'
const MAX_TEMPLATES = 40
const MAX_VARIABLES = 30

const mailTemplateVariableSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60, pattern: MAIL_VARIABLE_NAME_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 80, pattern: SINGLE_LINE }),
    sample: Type.String({ maxLength: 500, pattern: SINGLE_LINE }),
    kind: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('link')])),
  },
  { additionalProperties: false },
)

const mailTemplateSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 60, pattern: MAIL_TEMPLATE_KEY_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 80, pattern: SINGLE_LINE }),
    description: Type.String({ minLength: 1, maxLength: 300, pattern: SINGLE_LINE }),
    variables: Type.Array(mailTemplateVariableSchema, { maxItems: MAX_VARIABLES }),
    // The same limits an owner's edit has (`MailTemplateInputSchema`).
    subject: Type.String({ minLength: 1, maxLength: 200, pattern: SINGLE_LINE }),
    body: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
)

export const mailSchema = Type.Object(
  { templates: Type.Array(mailTemplateSchema, { minItems: 1, maxItems: MAX_TEMPLATES }) },
  { additionalProperties: false },
)

type MailRaw = Static<typeof mailSchema>

const MAIL_PERMISSIONS: readonly PluginPermission[] = ['mail.send', 'mail.send.external']

/** Every `{name}` a subject or body uses. */
function usedVariables(source: string): string[] {
  // `\\{name}` is a literal brace, not a variable.
  return [...source.replace(/\\\{/g, '').matchAll(/\{([a-zA-Z][a-zA-Z0-9.]*)\}/g)].map((match) => match[1])
}

/**
 * The names a template uses but does not declare. `site.name` and
 * `site.url` are the host's and always available.
 */
export function undeclaredMailVariables(template: {
  subject: string
  body: string
  variables: ReadonlyArray<{ name: string }>
}): string[] {
  const declared = new Set(template.variables.map((variable) => variable.name))
  const missing = [...usedVariables(template.subject), ...usedVariables(template.body)].filter(
    (name) => !declared.has(name) && name !== 'site.name' && name !== 'site.url',
  )
  return [...new Set(missing)]
}

/**
 * Cross-field rules the schema cannot say: templates need a permission to
 * send them, keys and variable names are unique, and no template claims the
 * host's `site.*` variables.
 */
export function assertMailCoherent(mail: MailRaw, permissions: readonly PluginPermission[]): void {
  if (!MAIL_PERMISSIONS.some((permission) => permissions.includes(permission))) {
    throw new Error(
      'Invalid plugin manifest: `mail.templates` is declared but neither the `mail.send` nor the `mail.send.external` permission is requested.',
    )
  }
  const keys = new Set<string>()
  for (const template of mail.templates) {
    if (keys.has(template.key)) {
      throw new Error(`Invalid plugin manifest: mail template key "${template.key}" is declared twice.`)
    }
    keys.add(template.key)
    const names = new Set<string>()
    for (const variable of template.variables) {
      if (variable.name.startsWith('site.')) {
        throw new Error(
          `Invalid plugin manifest: mail template "${template.key}" declares "${variable.name}"; \`site.*\` variables are filled in by the site.`,
        )
      }
      if (names.has(variable.name)) {
        throw new Error(
          `Invalid plugin manifest: mail template "${template.key}" declares the variable "${variable.name}" twice.`,
        )
      }
      names.add(variable.name)
      const problem = mailValueProblem(variable.kind, variable.sample)
      if (problem) {
        throw new Error(
          `Invalid plugin manifest: in mail template "${template.key}" the sample of "${variable.name}" ${problem}.`,
        )
      }
    }
    const undeclared = undeclaredMailVariables(template)
    if (undeclared.length > 0) {
      throw new Error(
        `Invalid plugin manifest: mail template "${template.key}" uses ${undeclared.map((name) => `{${name}}`).join(', ')} without declaring it under \`variables\`.`,
      )
    }
    const glued = gluedMailVariables(template)
    if (glued.length > 0) {
      throw new Error(
        `Invalid plugin manifest: in mail template "${template.key}" ${glued.map((name) => `{${name}}`).join(', ')} must stand alone. A \`link\` variable needs a space or a line break around it, or to be the whole address of a link (\`[Open]({${glued[0]}})\`); a \`text\` variable may not touch another variable or text that reads as an address.`,
      )
    }
  }
}

/**
 * The variables a template declares that would be left unfilled when it is
 * sent, because a link does not stand alone in it. Rendered with the
 * samples, by the renderer that sends. Where there is no HTML parser to
 * render with (a build tool), nothing is reported; the server, which always
 * has one, refuses such a manifest at install.
 */
export function gluedMailVariables(template: {
  subject: string
  body: string
  variables: ReadonlyArray<{ name: string; sample: string; kind?: 'text' | 'link' }>
}): string[] {
  try {
    return renderMailTemplate(
      { key: 'plugin.lint~template', subject: template.subject, body: template.body, variables: template.variables.map((variable) => ({ label: variable.name, ...variable })) },
      { 'site.name': 'Site', 'site.url': 'https://example.com', ...Object.fromEntries(template.variables.map((variable) => [variable.name, variable.sample])) },
    ).refused
  } catch (err) {
    if (err instanceof MailRendererUnavailableError) return []
    throw err
  }
}

/**
 * The parsed `mail` block as the manifest type declares it. There is no cast:
 * this compiles only while the schema's static type is assignable to the SDK
 * type, which keeps the two from drifting.
 */
export function mailDeclarations(mail: MailRaw): PluginManifest['mail'] {
  return {
    templates: mail.templates.map((template) => ({
      ...template,
      variables: template.variables.map((variable) => ({ ...variable })),
    })),
  }
}

/**
 * The prefix of every catalogue key that belongs to this plugin. It ends in
 * `~`, which neither a plugin id nor a template key can contain: with a dot
 * there, plugin `acme.desk` and plugin `acme.desk.pro` would share a prefix,
 * and one could shadow or delete the other's templates.
 */
export function pluginMailTemplatePrefix(pluginId: string): string {
  return `plugin.${pluginId}~`
}

/** The catalogue key of a plugin's template: `plugin.<pluginId>~<key>`. */
export function pluginMailTemplateKey(pluginId: string, key: string): string {
  return `${pluginMailTemplatePrefix(pluginId)}${key}`
}

/** A plugin's templates as catalogue entries, grouped under the plugin's name. */
export function pluginMailTemplateDefinitions(
  manifest: Pick<PluginManifest, 'id' | 'name' | 'mail'>,
): MailTemplateDefinition[] {
  return (manifest.mail?.templates ?? []).map((template) => ({
    key: pluginMailTemplateKey(manifest.id, template.key),
    label: template.label,
    description: template.description,
    group: manifest.name,
    variables: template.variables,
    defaultSubject: template.subject,
    defaultBody: template.body,
  }))
}
