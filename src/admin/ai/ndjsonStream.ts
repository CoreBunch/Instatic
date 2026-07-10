/** Validate and yield complete newline-delimited JSON records from a stream. */
import { safeParseJson } from '@core/utils/jsonValidate'
import type { Static, TSchema } from '@core/utils/typeboxHelpers'

export async function* readNdjsonStream<T extends TSchema>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  schema: T,
): AsyncGenerator<Static<T>> {
  const decoder = new TextDecoder()
  let lineBuffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    lineBuffer += decoder.decode(value, { stream: true })
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = safeParseJson(trimmed, schema)
      if (parsed.ok) yield parsed.value
    }
  }
}
