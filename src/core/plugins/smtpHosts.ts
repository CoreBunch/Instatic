import type { PluginPermission } from '@core/plugin-sdk'

export function assertSmtpAllowedHosts(
  permissions: readonly PluginPermission[],
  hosts: readonly string[] | undefined,
): void {
  if (permissions.includes('cms.mail.send') && !hosts?.length) {
    throw new Error('Invalid plugin manifest: `cms.mail.send` requires `smtpAllowedHosts`.')
  }
  if (hosts?.length && !permissions.includes('cms.mail.send')) {
    throw new Error('Invalid plugin manifest: `smtpAllowedHosts` requires `cms.mail.send`.')
  }
  for (const host of hosts ?? []) {
    const bare = host.startsWith('*.') ? host.slice(2) : host
    if (bare === 'localhost' || bare.endsWith('.localhost') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
      throw new Error(`Invalid plugin manifest: SMTP host "${host}" must be a public hostname.`)
    }
  }
}
