export function bunCommand(...args: string[]): string[] {
  return [process.execPath, ...args]
}

export function bunRunCommand(...args: string[]): string[] {
  return bunCommand('run', ...args)
}
