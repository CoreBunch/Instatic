import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { PluginMailSendInputSchema } from '@core/plugin-sdk/mailSchemas'
import { assertAllowedSmtpHost, resolveSmtpAddress } from './mail'

describe('plugin SMTP boundary', () => {
  it('accepts only declared hosts with the matching TLS mode', () => {
    expect(assertAllowedSmtpHost('MAIL.EXAMPLE.COM', 587, false, ['mail.example.com']))
      .toBe('mail.example.com')
    expect(() => assertAllowedSmtpHost('other.example.com', 587, false, ['mail.example.com']))
      .toThrow('smtpAllowedHosts')
    expect(() => assertAllowedSmtpHost('mail.example.com', 587, true, ['mail.example.com']))
      .toThrow('STARTTLS')
  })

  it('rejects private DNS answers even when another address is public', async () => {
    await expect(resolveSmtpAddress('mail.example.com', async () => [
      { address: '8.8.8.8' },
      { address: '127.0.0.1' },
    ])).rejects.toThrow('public addresses')
    await expect(resolveSmtpAddress('127.0.0.1', async () => []))
      .rejects.toThrow('hostname')
  })

  it('prefers a public IPv4 answer when DNS also returns IPv6', async () => {
    expect(await resolveSmtpAddress('mail.example.com', async () => [
      { address: '2606:4700:4700::1111' },
      { address: '8.8.8.8' },
    ])).toBe('8.8.8.8')
  })

  it('rejects malformed messages before they reach the SMTP handler', () => {
    const valid = {
      transport: {
        host: 'mail.example.com', port: 587, secure: false,
        username: 'forms@example.com', password: 'secret',
      },
      message: {
        from: 'forms@example.com', to: 'team@example.com',
        subject: 'New application', text: 'Applicant details',
      },
    }
    expect(Value.Check(PluginMailSendInputSchema, valid)).toBe(true)
    expect(Value.Check(PluginMailSendInputSchema, {
      ...valid,
      message: { ...valid.message, subject: 'Injected\r\nBCC: attacker@example.com' },
    })).toBe(false)
  })
})
