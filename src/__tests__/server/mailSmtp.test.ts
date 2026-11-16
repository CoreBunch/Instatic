import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { formatFromHeader, MailDeliveryError, sendViaSmtp } from '../../../server/mail/smtpDriver'

/** A minimal plaintext SMTP sink: accepts one message and records the wire data. */
function startSmtpSink(options: { rejectAuth?: boolean } = {}): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = []
  const server = createServer((socket) => {
    let inData = false
    let buffer = ''
    socket.write('220 sink ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          received.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 queued\r\n')
          continue
        }
        const eol = buffer.indexOf('\r\n')
        if (eol < 0) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') socket.write('250-sink\r\n250 AUTH PLAIN\r\n')
        else if (verb === 'AUTH') socket.write(options.rejectAuth ? '535 bad credentials\r\n' : '235 ok\r\n')
        else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n') }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received })
    })
  })
}

const HOST = '127.0.0.1'
const USERNAME = 'mailer'
const PASSWORD = 'smtp-secret-value'
const ENVELOPE = { fromHeader: formatFromHeader('Ex "Site"', 'hello@example.com'), replyTo: 'help@example.com' }
const send = (port: number) => sendViaSmtp({ host: HOST, port, username: USERNAME }, PASSWORD, ENVELOPE, MAIL)
const MAIL = { to: 'reader@example.com', subject: 'Hello there', text: 'First line\r\n.leading dot line' }

describe('SMTP transport against a local sink', () => {
  let previous: string | undefined
  let sink: Awaited<ReturnType<typeof startSmtpSink>> | null = null

  beforeEach(() => {
    previous = process.env.MAIL_ALLOW_PRIVATE_HOSTS
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.MAIL_ALLOW_PRIVATE_HOSTS
    else process.env.MAIL_ALLOW_PRIVATE_HOSTS = previous
    sink?.server.close()
    sink = null
  })

  it('delivers a message with the quoted sender name when private hosts are allowed', async () => {
    process.env.MAIL_ALLOW_PRIVATE_HOSTS = '1'
    sink = await startSmtpSink()
    await send(sink.port)
    expect(sink.received).toHaveLength(1)
    const wire = sink.received[0]
    expect(wire).toContain('From: "Ex \\"Site\\"" <hello@example.com>')
    expect(wire).toContain('To: reader@example.com')
    expect(wire).toContain('Reply-To: help@example.com')
    expect(wire).toContain('Subject: Hello there')
    expect(wire).toContain('First line')
  })

  it('refuses a private host by default, before any connection is made', async () => {
    delete process.env.MAIL_ALLOW_PRIVATE_HOSTS
    sink = await startSmtpSink()
    await expect(send(sink.port)).rejects.toBeInstanceOf(MailDeliveryError)
    expect(sink.received).toHaveLength(0)
  })

  it('reports rejected credentials without echoing the password', async () => {
    process.env.MAIL_ALLOW_PRIVATE_HOSTS = '1'
    sink = await startSmtpSink({ rejectAuth: true })
    const failure = await send(sink.port).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(MailDeliveryError)
    expect((failure as Error).message).toBe('The SMTP server rejected the username or password.')
    expect((failure as Error).message).not.toContain(PASSWORD)
  })
})
