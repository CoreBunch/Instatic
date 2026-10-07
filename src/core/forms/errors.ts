export class FormConfigurationError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`${path}: ${message}`)
    this.name = 'FormConfigurationError'
    this.path = path
  }
}
