import { createHash } from 'node:crypto'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import type { Source, SourceField } from './source'

export function objectId(source: Source, kind: string, key: string | number) {
  const hash = createHash('sha256').update(JSON.stringify([source.site, source.blog, kind, key])).digest('hex')
  return 'wp-' + hash.slice(0, 24)
}

export function tableId(source: Source, type: string) {
  if (type === 'post') return 'posts'
  if (type === 'page') return 'pages'
  return objectId(source, 'type', type)
}

export function row(id: string, tableId: string, slug: string, cells: DataRow['cells'], date: string): DataRow {
  return { id, tableId, slug, cells, status: 'draft', createdAt: date, updatedAt: date,
    authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
    author: null, createdBy: null, updatedBy: null, publishedBy: null, publishedAt: null, scheduledPublishAt: null, deletedAt: null }
}

export function table(id: string, slug: string, name: string, fields: DataField[], date: string): DataTable {
  return { id, slug, name, kind: 'data', singularLabel: name, pluralLabel: name, fields,
    primaryFieldId: 'title', routeBase: '', system: false, createdByUserId: null,
    updatedByUserId: null, createdAt: date, updatedAt: date }
}

export const fieldId = (name: string) => 'acf_' + name
export function mappedField(source: Source, field: SourceField): DataField | undefined {
  const common = { id: fieldId(field.name), label: field.label }
  switch (field.type) {
    case 'text': case 'number': case 'email': case 'url': return { ...common, type: field.type }
    case 'textarea': return { ...common, type: 'longText' }
    case 'true_false': return { ...common, type: 'boolean' }
    case 'image': case 'gallery': case 'file': return { ...common, type: 'media', mediaKind: field.type === 'file' ? 'any' : 'image', allowMultiple: field.type === 'gallery' }
    case 'post_object': case 'relationship': {
      const target = field.post_type
      if (!Array.isArray(target) || target.length !== 1 || !source.types.some(t => t.name === target[0])) return
      return { ...common, type: 'relation', targetTableId: tableId(source, target[0]), allowMultiple: field.type === 'relationship' || !!field.multiple }
    }
  }
}

export function contentModel(source: Source, system: DataTable[], media: Map<number, string>, warnings: Set<string>,
  bodies: Map<number, string>, pageIds: Map<number, string>) {
  const tables: DataTable[] = []
  const rows: DataRow[] = []
  const posts = new Map(source.posts.map(p => [p.id, p]))
  for (const taxonomy of source.taxonomies) {
    const tid = objectId(source, 'taxonomy', taxonomy.name)
    tables.push(table(tid, 'wp-tax-' + taxonomy.name.replaceAll('_', '-'), taxonomy.label, [
      { id: 'title', type: 'text', label: 'Name' }, { id: 'parent', type: 'relation', targetTableId: tid, label: 'Parent' },
    ], source.date))
    for (const term of taxonomy.terms) rows.push(row(objectId(source, taxonomy.name + ':term', term.id), tid, term.slug, {
      title: term.name, parent: term.parent ? objectId(source, taxonomy.name + ':term', term.parent) : null,
    }, source.date))
  }
  const pageCells = new Map<number, DataRow['cells']>()
  for (const type of source.types) {
    const tid = tableId(source, type.name)
    const existing = system.find(t => t.id === tid)
    const target = existing ? structuredClone(existing) : table(tid, type.name.replaceAll('_', '-'), type.label, buildPostTypeDefaultFields(), source.date)
    const entries = source.posts.filter(p => p.type === type.name)
    if (target.kind !== 'page') {
      target.kind = 'postType'
      const sample = entries.find(p => p.public)
      const paths = sample ? new URL(sample.url).pathname.split('/').filter(Boolean) : []
      target.routeBase = sample ? '/' + paths.slice(0, -1).join('/') : '/' + target.slug
      target.singularLabel = type.singular
      target.pluralLabel = type.label
    }
    const taxes = source.taxonomies.filter(t => t.types.includes(type.name))
    for (const tax of taxes) target.fields.push({ type: 'relation', id: 'tax_' + tax.name, label: tax.label,
      targetTableId: objectId(source, 'taxonomy', tax.name), allowMultiple: true })
    const fields = type.fields.flatMap(f => {
      const mapped = mappedField(source, f)
      if (!mapped || target.fields.some(existing => existing.id === mapped.id)) {
        warnings.add(type.name + '.' + f.name + ': source package only (' + f.type + ')')
        return []
      }
      target.fields.push(mapped)
      return [{ f, mapped }]
    })
    const publicKeys = new Set(entries.flatMap(p => Object.keys(p.publicMeta ?? {})))
    for (const key of publicKeys) {
      if (!type.fields.some(f => f.name === key)) warnings.add(type.name + '.' + key + ': raw custom metadata retained in private source package')
    }
    target.fields.push({ type: 'text', id: 'wp_byline', label: 'WordPress byline' })
    tables.push(target)
    for (const p of entries) {
      for (const code of p.shortcodes) warnings.add(p.type + ' #' + p.id + ': verify shortcode [' + code + ']')
      const draft = type.name !== 'page' && p.status === 'draft' && !p.passwordProtected
      if (!p.public && !draft) { warnings.add(p.type + ' #' + p.id + ': ' + p.status + '/restricted, retained in private source package'); continue }
      const cells: DataRow['cells'] = { wp_byline: p.authorName ?? '' }
      for (const tax of taxes) cells['tax_' + tax.name] = (p.terms[tax.name] ?? []).map(id => objectId(source, tax.name + ':term', id))
      for (const { f, mapped } of fields) {
        const value = p.fields[f.key]
        if (value == null) continue
        if (mapped.type === 'relation' || mapped.type === 'media') {
          const ids = (Array.isArray(value) ? value : [value]).filter(v => v !== '' && v !== false && v !== 0)
          const resolved = ids.flatMap(v => {
            const related = posts.get(Number(v))
            const match = mapped.type === 'media' ? media.get(Number(v)) : related?.public && tableId(source, related.type) === mapped.targetTableId
              ? related.type === 'page' ? pageIds.get(related.id) : objectId(source, 'post', related.id) : undefined
            if (!match) warnings.add(p.type + ' #' + p.id + ': unresolved ' + f.name + ' reference ' + String(v))
            return match ? [match] : []
          })
          cells[mapped.id] = mapped.allowMultiple ? resolved : resolved[0] ?? null
        } else if (mapped.type === 'boolean') cells[mapped.id] = value === true || value === 1 || value === '1'
        else if (mapped.type === 'number') cells[mapped.id] = value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
        else if (typeof value === 'string') cells[mapped.id] = value
        else warnings.add(p.type + ' #' + p.id + ': unexpected value for ' + f.name)
      }
      if (type.name === 'page') { pageCells.set(p.id, cells); continue }
      const slug = p.slug || 'entry-' + p.id
      if (p.public) {
        const path = new URL(p.url)
        if (path.search || path.pathname.replace(/\/$/, '') !== (target.routeBase === '/' ? '' : target.routeBase) + '/' + slug)
          warnings.add(p.url + ': source permalink differs from destination')
      }
      const entry = row(objectId(source, 'post', p.id), tid, slug, { ...cells, title: p.title, slug,
        body: bodies.get(p.id) ?? p.raw, featuredMedia: media.get(p.featured) ?? null }, source.date)
      const timestamp = (value: string) => {
        const time = Date.parse(value.replace(' ', 'T') + 'Z')
        return Number.isFinite(time) ? new Date(time).toISOString() : source.date
      }
      entry.createdAt = timestamp(p.date)
      entry.updatedAt = timestamp(p.modified)
      rows.push(entry)
    }
  }
  return { tables, rows, pageCells }
}
