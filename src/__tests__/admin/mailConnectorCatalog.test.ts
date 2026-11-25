import { describe, expect, it } from 'bun:test'
import { addableConnectorSpecs, connectorTakesSecret, looksLikeLocalMailHost } from '@admin/pages/email/connectorCatalog'

describe('looksLikeLocalMailHost', () => {
  it('reads names and addresses of this machine or network as local', () => {
    for (const host of ['localhost', 'mailpit', 'postfix.internal', 'relay.local', 'mail.lan', '127.0.0.1', '10.0.4.2', '192.168.1.20', '172.20.0.5', ' Localhost. ']) {
      expect(looksLikeLocalMailHost(host)).toBe(true)
    }
  })

  it('leaves public hosts and an empty field alone', () => {
    for (const host of ['', 'smtp.gmail.com', 'smtp.example.com', '8.8.8.8', '172.32.0.1', 'mail.localhost.example.com']) {
      expect(looksLikeLocalMailHost(host)).toBe(false)
    }
  })
})

describe('sendmail connector kind', () => {
  it('is offered only when the server enables it, and takes no secret', () => {
    expect(addableConnectorSpecs(false).map((spec) => spec.kind)).not.toContain('sendmail')
    expect(addableConnectorSpecs(true).map((spec) => spec.kind)).toContain('sendmail')
    expect(addableConnectorSpecs(false)[0].kind).toBe('resend')
    expect(connectorTakesSecret('sendmail')).toBe(false)
    expect(connectorTakesSecret('smtp')).toBe(true)
  })
})
