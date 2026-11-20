export type ColorVariable = { name: string; value: string }

export function findColorVariable(value: string, variables: readonly ColorVariable[]) {
  const name = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
  return name ? variables.find((variable) => variable.name === name) : undefined
}

export function resolveColorPreview(value: string, variables: readonly ColorVariable[]): string {
  // Preview swatches live in the editor document, outside the site's CSS scope.
  return value.replace(/var\(\s*(--[a-z0-9_-]+)\s*\)/gi, (reference, name: string) =>
    variables.find((variable) => variable.name === name)?.value ?? reference)
}
