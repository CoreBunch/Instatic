/** Resolve the preview against the site's palette while keeping the authored CSS variable in the field. */
export function resolveColorPreview(value: string, variables: readonly { name: string; value: string }[]): string {
  const name = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
  return (name && variables.find((variable) => variable.name === name)?.value) || value
}
