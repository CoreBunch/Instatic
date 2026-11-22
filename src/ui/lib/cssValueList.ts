/** Split a CSS value list without splitting functions, quoted URLs or escapes. */
export function splitCssList(value: string, separator: ',' | ' ' = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\\') {
      index++
    } else if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
    } else if (depth === 0 && (separator === ',' ? char === ',' : /\s/.test(char))) {
      const part = value.slice(start, index).trim()
      if (part) parts.push(part)
      start = index + 1
    }
  }
  const last = value.slice(start).trim()
  if (last) parts.push(last)
  return parts
}

export function isGradientImage(value: string): boolean {
  return /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value.trim())
}
