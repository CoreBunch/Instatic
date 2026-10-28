/**
 * Registry descriptions are free text and sometimes carry markdown (links,
 * emphasis, inline code). The panel shows them on one or two lines, so
 * flatten the markup instead of rendering it. Emphasis markers are only
 * removed at word edges, and a lone `~` is text: `snake_case`, `my_lib_v2`
 * and `~/.config` survive, `**every**`, `_Fast_` and `~~old~~` flatten.
 */
const MARKER = String.raw`(?:\*+|_+|~~+)`

export function cleanPackageDescription(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(new RegExp(String.raw`(^|[\s(])${MARKER}(?=\S)`, 'g'), '$1')
    .replace(new RegExp(String.raw`(?<=\S)${MARKER}(?=[\s.,;:!?)]|$)`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
}
