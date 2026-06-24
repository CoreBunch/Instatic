/**
 * pillAccent — deterministic accent token for tinted pills.
 *
 * Uses the first meaningful alphanumeric character in the input string as the
 * accent key, so selector punctuation like `.`, `#`, and `::` does not collapse
 * unrelated labels into punctuation-led buckets. Purely presentational; the
 * accent has no semantic meaning.
 */

const LETTER_ACCENTS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
] as const
const DIGIT_ACCENTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

const PILL_ACCENTS = [...LETTER_ACCENTS, ...DIGIT_ACCENTS] as const
const PILL_ACCENT_BY_CHAR = new Map<string, PillAccent>(
  PILL_ACCENTS.map((accent) => [accent, accent]),
)
const MEANINGFUL_ACCENT_CHAR_RE = /[a-z0-9]/i

export type PillAccent = typeof PILL_ACCENTS[number]

const PILL_ACCENT_TOKEN: Record<PillAccent, string> = {
  a: 'var(--accent-1)',
  b: 'var(--accent-3)',
  c: 'var(--accent-2)',
  d: 'var(--accent-4)',
  e: 'var(--accent-5)',
  f: 'var(--accent-6)',
  g: 'var(--accent-7)',
  h: 'var(--accent-8)',
  i: 'var(--accent-2)',
  j: 'var(--accent-9)',
  k: 'var(--accent-10)',
  l: 'var(--accent-1)',
  m: 'var(--accent-6)',
  n: 'var(--accent-4)',
  o: 'var(--accent-3)',
  p: 'var(--accent-2)',
  q: 'var(--accent-9)',
  r: 'var(--accent-8)',
  s: 'var(--accent-6)',
  t: 'var(--accent-7)',
  u: 'var(--accent-3)',
  v: 'var(--accent-2)',
  w: 'var(--accent-4)',
  x: 'var(--accent-1)',
  y: 'var(--accent-7)',
  z: 'var(--accent-3)',
  0: 'var(--accent-1)',
  1: 'var(--accent-2)',
  2: 'var(--accent-3)',
  3: 'var(--accent-4)',
  4: 'var(--accent-5)',
  5: 'var(--accent-7)',
  6: 'var(--accent-8)',
  7: 'var(--accent-9)',
  8: 'var(--accent-6)',
  9: 'var(--accent-10)',
}

function firstMeaningfulAccentChar(name: string): string {
  const trimmed = name.trim().toLowerCase()
  for (const char of trimmed) {
    if (MEANINGFUL_ACCENT_CHAR_RE.test(char)) return char
  }
  return trimmed[0] ?? ''
}

export function pillAccent(name: string): PillAccent {
  const accentChar = firstMeaningfulAccentChar(name)
  return PILL_ACCENT_BY_CHAR.get(accentChar) ?? PILL_ACCENTS[0]
}

export function pillAccentVar(accent: PillAccent): string {
  return PILL_ACCENT_TOKEN[accent]
}
