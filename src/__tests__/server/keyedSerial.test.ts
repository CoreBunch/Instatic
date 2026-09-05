/**
 * Per-key promise serializer — same-key calls run one at a time in order,
 * different keys interleave, and a rejection never blocks the queue.
 */
import { describe, expect, test } from 'bun:test'
import { createKeyedSerializer } from '../../../server/util/keyedSerial'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createKeyedSerializer', () => {
  test('same-key calls never overlap and keep arrival order', async () => {
    const serialize = createKeyedSerializer()
    const events: string[] = []
    const first = deferred<void>()

    const a = serialize('plugin', async () => {
      events.push('a:start')
      await first.promise
      events.push('a:end')
      return 'a'
    })
    const b = serialize('plugin', async () => {
      events.push('b:start')
      return 'b'
    })

    await Promise.resolve()
    expect(events).toEqual(['a:start'])
    first.resolve()
    expect(await a).toBe('a')
    expect(await b).toBe('b')
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  test('different keys run concurrently', async () => {
    const serialize = createKeyedSerializer()
    const gate = deferred<void>()
    const events: string[] = []

    const a = serialize('one', async () => {
      events.push('one')
      await gate.promise
    })
    const b = serialize('two', async () => {
      events.push('two')
    })
    await b
    expect(events).toEqual(['one', 'two'])
    gate.resolve()
    await a
  })

  test('a rejected call surfaces to its caller and does not block the next one', async () => {
    const serialize = createKeyedSerializer()
    const failing = serialize('plugin', async () => {
      throw new Error('boom')
    })
    const following = serialize('plugin', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    expect(await following).toBe('ok')
  })
})
