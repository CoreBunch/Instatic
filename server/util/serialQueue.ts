/**
 * Runs async work one piece after another, in the order it was handed in.
 * A piece that fails does not stop the queue; its caller gets the failure.
 */
export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (work) => {
    const result = tail.then(work, work)
    tail = result.catch(() => undefined)
    return result
  }
}
