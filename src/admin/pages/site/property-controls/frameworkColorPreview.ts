type ColorVariable = { name: string; value: string }

export function findColorVariable(value: string, variables: readonly ColorVariable[]) {
  const name = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
  return name ? variables.find((variable) => variable.name === name) : undefined
}

export function resolveColorPreview(value: string, variables: readonly ColorVariable[]): string {
  return findColorVariable(value, variables)?.value ?? value
}
