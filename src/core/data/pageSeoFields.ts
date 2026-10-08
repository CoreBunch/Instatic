import type { DataField } from './schemas'

/** Built-in metadata uses the same field/cell primitives as every CMS collection. */
export const PAGE_SEO_FIELDS: DataField[] = [
  { id: 'seoCanonical', label: 'Canonical URL', type: 'url', builtIn: true },
  { id: 'seoAlternates', label: 'Language alternatives', type: 'repeater', builtIn: true, fields: [
    { id: 'language', label: 'Language tag', type: 'text', required: true },
    { id: 'href', label: 'URL', type: 'url', required: true },
  ] },
  { id: 'seoMeta', label: 'Metadata', type: 'repeater', builtIn: true, fields: [
    { id: 'attribute', label: 'Attribute', type: 'select', required: true, options: [
      { id: 'name', label: 'Name', value: 'name' },
      { id: 'property', label: 'Property', value: 'property' },
      { id: 'http-equiv', label: 'HTTP equivalent', value: 'http-equiv' },
    ] },
    { id: 'key', label: 'Key', type: 'text', required: true },
    { id: 'content', label: 'Content', type: 'text' },
    { id: 'media', label: 'Media query', type: 'text' },
  ] },
  { id: 'seoLinks', label: 'Metadata links', type: 'repeater', builtIn: true, fields: [
    { id: 'rel', label: 'Relation', type: 'text', required: true },
    { id: 'href', label: 'URL', type: 'url', required: true },
    { id: 'type', label: 'MIME type', type: 'text' },
    { id: 'sizes', label: 'Sizes', type: 'text' },
    { id: 'media', label: 'Media query', type: 'text' },
  ] },
  { id: 'seoStructuredData', label: 'Structured data (JSON-LD)', type: 'longText', builtIn: true,
    description: 'A JSON array of JSON-LD objects. Native template tokens are resolved in string values.' },
]

export const PAGE_SEO_CELL_IDS = ['seoTitle', 'seoDescription', ...PAGE_SEO_FIELDS.map((field) => field.id)]
