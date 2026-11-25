import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  retryForSendmailFailure,
  sendmailPath,
  sendViaSendmail,
} from '../../../server/mail/sendmailDriver'
import { formatFromHeader, MailDeliveryError } from '../../../server/mail/smtpDriver'

const ENVELOPE = { fromHeader: formatFromHeader('Ex "Site"', 'hello@example.com'), replyTo: 'help@example.com' }
const MAIL = { to: 'reader@example.com', subject: 'Hello there', text: 'First line\n.leading dot line', html: '<p>Hi</p>' }

describe('sendmail transport against a stub command', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'instatic-sendmail-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A sendmail stand-in that records its arguments and stdin, then exits with `exitCode`. */
  async function stub(exitCode = 0): Promise<{ env: Record<string, string>; args: () => Promise<string[]>; stdin: () => Promise<string> }> {
    const path = join(dir, 'sendmail')
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho "secret diagnostic text" >&2\nexit ${exitCode}\n`,
    )
    await chmod(path, 0o755)
    return {
      env: { MAIL_SENDMAIL_PATH: path },
      args: async () => (await readFile(join(dir, 'args'), 'utf8')).trimEnd().split('\n'),
      stdin: () => readFile(join(dir, 'stdin'), 'utf8'),
    }
  }

  it('passes the envelope sender and recipient as arguments and the message on stdin', async () => {
    const command = await stub()
    const id = await sendViaSendmail(ENVELOPE, MAIL, command.env)
    expect(await command.args()).toEqual(['-i', '-f', 'hello@example.com', 'reader@example.com'])
    const message = await command.stdin()
    expect(message).toContain('From: "Ex \\"Site\\"" <hello@example.com>')
    expect(message).toContain('To: reader@example.com')
    expect(message).toContain('Reply-To: help@example.com')
    expect(message).toContain('Subject: Hello there')
    expect(message).toContain('.leading dot line')
    expect(message).not.toContain('\r\n')
    expect(id).toMatch(/^<.+@.+>$/)
    expect(message).toContain(`Message-ID: ${id}`)
  })

  it('refuses before running anything when no command is configured', async () => {
    for (const env of [{}, { MAIL_SENDMAIL_PATH: '' }, { MAIL_SENDMAIL_PATH: 'sendmail' }]) {
      const err = await sendViaSendmail(ENVELOPE, MAIL, env).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MailDeliveryError)
      expect((err as MailDeliveryError).retry).toBe('connector')
      expect((err as MailDeliveryError).message).toContain('MAIL_SENDMAIL_PATH')
    }
  })

  it('reads only an absolute path from the environment', () => {
    expect(sendmailPath({})).toBeNull()
    expect(sendmailPath({ MAIL_SENDMAIL_PATH: '  ' })).toBeNull()
    expect(sendmailPath({ MAIL_SENDMAIL_PATH: 'sendmail' })).toBeNull()
    expect(sendmailPath({ MAIL_SENDMAIL_PATH: './sendmail' })).toBeNull()
    expect(sendmailPath({ MAIL_SENDMAIL_PATH: '/usr/sbin/sendmail' })).toBe('/usr/sbin/sendmail')
  })

  it('classifies exit statuses and never shows the command output', async () => {
    const cases: Array<[number, MailDeliveryError['retry']]> = [
      [75, 'later'], [74, 'later'], [1, 'later'], [77, 'connector'], [78, 'connector'],
      [127, 'connector'], [65, 'never'], [67, 'never'], [99, 'never'],
    ]
    for (const [status, retry] of cases) {
      const command = await stub(status)
      const err = await sendViaSendmail(ENVELOPE, MAIL, command.env).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MailDeliveryError)
      expect((err as MailDeliveryError).retry).toBe(retry)
      expect((err as MailDeliveryError).message).not.toContain('secret diagnostic')
      expect((err as MailDeliveryError).message).not.toContain(MAIL.text)
    }
    const temp = await stub(75)
    const err = await sendViaSendmail(ENVELOPE, MAIL, temp.env).catch((e: unknown) => e)
    expect((err as Error).message).toBe('The sendmail command could not take the message right now (temporary failure).')
  })

  it('treats a missing or non-executable command as the connector\'s fault', async () => {
    const missing = await sendViaSendmail(ENVELOPE, MAIL, { MAIL_SENDMAIL_PATH: join(dir, 'absent') }).catch((e: unknown) => e)
    expect((missing as MailDeliveryError).retry).toBe('connector')
    expect((missing as Error).message).toContain('could not be started')

    const plain = join(dir, 'plain')
    await writeFile(plain, '#!/bin/sh\nexit 0\n')
    await chmod(plain, 0o644)
    const denied = await sendViaSendmail(ENVELOPE, MAIL, { MAIL_SENDMAIL_PATH: plain }).catch((e: unknown) => e)
    expect((denied as MailDeliveryError).retry).toBe('connector')
  })

  it('does not run a command for an address that would read as an option', async () => {
    const command = await stub()
    const err = await sendViaSendmail(ENVELOPE, { ...MAIL, to: '-oQ/tmp/x@example.com' }, command.env).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailDeliveryError)
    expect(await Bun.file(join(dir, 'args')).exists()).toBe(false)
  })
})

describe('retryForSendmailFailure', () => {
  it('retries a timeout and a signal, and gives up on an unrecognised failure', () => {
    expect(retryForSendmailFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('later')
    expect(retryForSendmailFailure(new Error('Sendmail was terminated by SIGKILL'))).toBe('later')
    expect(retryForSendmailFailure(new Error('something else'))).toBe('never')
  })
})
