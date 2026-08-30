/**
 * CSS identifier escaping — shared by `cssClass.ts` (builds class-kind
 * selectors) and `classNames.ts` (builds class-attribute tokens for the
 * publisher and canvas).
 *
 * The implementation matches the algorithm specified in CSS.escape
 * (https://drafts.csswg.org/cssom/#serialize-an-identifier). Vendored here
 * because the module must work in both the browser bundle and the headless
 * publisher (Bun server) without an environment-specific shim.
 */

export function escapeCssIdentifier(value: string): string {
  let escaped = ''

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    const char = value.charAt(index)

    // NULL (U+0000) serializes to the replacement character U+FFFD.
    if (codeUnit === 0x0000) {
      escaped += '\uFFFD'
      continue
    }

    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (
        index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        value.charCodeAt(0) === 0x002d
      )
    ) {
      escaped += `\\${codeUnit.toString(16)} `
      continue
    }

    if (index === 0 && codeUnit === 0x002d && value.length === 1) {
      escaped += '\\-'
      continue
    }

    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      escaped += char
      continue
    }

    escaped += `\\${char}`
  }

  return escaped
}
