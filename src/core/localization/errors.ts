/** A localization edit that would change shared structure or invalid stored content. */
export class LocalizationValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(message)
    this.name = 'LocalizationValidationError'
    this.path = path
  }
}
