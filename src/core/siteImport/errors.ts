/**
 * Typed error classes for the Super Import pipeline.
 *
 * Callers distinguish these with `instanceof` to render specific error
 * states (see `importPlanning.ts`). Headless — no admin/React/server
 * imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

/** Thrown when the import input contains no processable files. */
export class EmptyImportError extends Error {
  constructor() {
    super('Import input is empty — drop at least one file')
    this.name = 'EmptyImportError'
  }
}

/** Thrown when the aggregate input size exceeds the configured limit. */
export class OversizeImportError extends Error {
  readonly sizeBytes: number
  readonly limitBytes: number
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Import aggregate size ${sizeBytes} bytes exceeds the ${limitBytes}-byte limit`,
    )
    this.name = 'OversizeImportError'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when a zip's uncompressed size exceeds the zip-bomb guard limit. */
export class ZipBombError extends Error {
  readonly uncompressedBytes: number
  readonly limitBytes: number
  constructor(uncompressedBytes: number, limitBytes: number) {
    super(
      `Zip uncompressed size ${uncompressedBytes} bytes exceeds the ${limitBytes}-byte limit (zip-bomb guard)`,
    )
    this.name = 'ZipBombError'
    this.uncompressedBytes = uncompressedBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when the file count in the import exceeds the configured limit. */
export class TooManyFilesError extends Error {
  readonly count: number
  readonly limit: number
  constructor(count: number, limit: number) {
    super(`Import contains ${count} files, exceeding the ${limit}-file limit`)
    this.name = 'TooManyFilesError'
    this.count = count
    this.limit = limit
  }
}

/**
 * Thrown when a path contains `..` segments, an absolute prefix (`/` or a
 * Windows drive letter), or other traversal attempts.
 */
export class PathTraversalError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`Unsafe path rejected — path traversal or absolute path detected: "${path}"`)
    this.name = 'PathTraversalError'
    this.path = path
  }
}
