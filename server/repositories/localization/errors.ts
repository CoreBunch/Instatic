export class LocalizationError extends Error {
  readonly path: string

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalizationError'
    this.path = path
  }
}
