/**
 * The publish failure an author can fix, reported so they can fix it.
 *
 * A script importing an undeclared package is a blocking diagnostic naming the
 * package and the file. It used to reach the router's generic catch, which
 * deliberately refuses to echo `err.message`, so the publish button said
 * "Internal server error" while the reason sat in the server log. Two people
 * hit it on two different sites and neither could have guessed.
 *
 * These pin the two halves of the fix: the diagnostics survive as DATA, and
 * the message is assembled only from diagnostic fields — never from a raw
 * thrown message, which is what makes it safe to send to a client at all.
 */

import { describe, expect, test } from 'bun:test'
import { PublishRuntimeBuildError, publishBuildErrorMessage } from '../publish/publishBuildError'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

const undeclaredPackage: SiteRuntimeDiagnostic = {
  code: 'undeclared-dependency',
  severity: 'error',
  message: 'Package "three" is imported by a runtime script but is not declared in dependencies (static import in gallery.html-inline-script-5.js).',
  packageName: 'three',
  path: 'gallery.html-inline-script-5.js',
}

describe('PublishRuntimeBuildError', () => {
  test('keeps the diagnostics as data, not as a formatted string', () => {
    const err = new PublishRuntimeBuildError('gallery', [undeclaredPackage])
    expect(err.diagnostics).toEqual([undeclaredPackage])
    expect(err.pageSlug).toBe('gallery')
  })

  test('is distinguishable from an ordinary Error', () => {
    // The handler branches on this: anything else keeps falling through to
    // the generic 500, which is right — only these diagnostics are known to
    // be author-facing.
    const err: unknown = new PublishRuntimeBuildError('gallery', [undeclaredPackage])
    expect(err instanceof PublishRuntimeBuildError).toBe(true)
    expect(new Error('select * from users failed') instanceof PublishRuntimeBuildError).toBe(false)
  })
})

describe('publishBuildErrorMessage', () => {
  test('names the page and repeats the diagnostic', () => {
    const message = publishBuildErrorMessage(new PublishRuntimeBuildError('gallery', [undeclaredPackage]))
    expect(message).toContain('gallery')
    expect(message).toContain('"three"')
    expect(message).toContain('not declared in dependencies')
  })

  test('carries every diagnostic, not just the first', () => {
    const second: SiteRuntimeDiagnostic = { ...undeclaredPackage, message: 'Package "gsap" is not declared.', packageName: 'gsap' }
    const message = publishBuildErrorMessage(new PublishRuntimeBuildError('home', [undeclaredPackage, second]))
    expect(message).toContain('"three"')
    expect(message).toContain('"gsap"')
  })

  test('says something useful even with no diagnostics', () => {
    const message = publishBuildErrorMessage(new PublishRuntimeBuildError('home', []))
    expect(message).toContain('home')
    expect(message.length).toBeGreaterThan(20)
  })

  test('is built only from diagnostic fields', () => {
    // The guard that makes this safe to send to a client: the thrown Error's
    // own message could carry anything, so it must never be interpolated.
    const err = new PublishRuntimeBuildError('home', [undeclaredPackage])
    err.message = 'select secret from users where id = 1 -- D:\\srv\\app\\db.ts'
    const message = publishBuildErrorMessage(err)
    expect(message).not.toContain('select secret')
    expect(message).not.toContain('D:\\srv')
  })
})
