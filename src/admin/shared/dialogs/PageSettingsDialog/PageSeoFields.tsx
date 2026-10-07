import { useId, type ChangeEvent, type Dispatch, type SetStateAction } from 'react'
import {
  SEO_LINK_RELATIONS,
  type PageSeo, type SeoAlternate, type SeoMeta, type SeoLink,
} from '@core/page-tree'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import seoStyles from './PageSeoFields.module.css'
import styles from '../SiteCreateDialog/SiteCreateDialog.module.css'

interface ListField<T> {
  key: Exclude<keyof T, 'id'>
  label: string
  options?: readonly string[]
}

/** Ordered metadata retains repeated properties and stable native repeater item IDs. */
function SeoList<T extends { id: string }>({ label, items, fields, createItem, onChange }: {
  label: string
  items: T[]
  fields: ListField<T>[]
  createItem: () => T
  onChange: (items: T[]) => void
}) {
  const prefix = useId()
  function update(id: string, key: keyof T, value: string) {
    onChange(items.map((item) => item.id === id ? { ...item, [key]: value } : item))
  }
  function move(index: number, offset: number) {
    const next = [...items]
    const target = index + offset
    if (target < 0 || target >= items.length) return
    const moving = next[index]
    next[index] = next[target]
    next[target] = moving
    onChange(next)
  }
  return (
    <fieldset className={cn(styles.field, seoStyles.group)}>
      <legend className={styles.label}>{label}</legend>
      {items.map((item, index) => (
        <div key={item.id} className={styles.field}>
          {fields.map((field) => {
            const id = `${prefix}-${item.id}-${String(field.key)}`
            const value = String(item[field.key] ?? '')
            return <div key={String(field.key)} className={styles.field}>
              <label htmlFor={id} className={styles.label}>{field.label} {index + 1}</label>
              {field.options
                ? <Select id={id} value={value} options={field.options.map((option) => ({ value: option, label: option }))}
                    onChange={(event) => update(item.id, field.key, event.target.value)} />
                : <Input id={id} fieldSize="sm" value={value} onChange={(event) => update(item.id, field.key, event.target.value)} />}
            </div>
          })}
          <div>
            <Button type="button" size="xs" variant="secondary" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${label} ${index + 1} up`}>Up</Button>
            <Button type="button" size="xs" variant="secondary" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${label} ${index + 1} down`}>Down</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => onChange(items.filter((entry) => entry.id !== item.id))} aria-label={`Remove ${label} ${index + 1}`}>Remove</Button>
          </div>
        </div>
      ))}
      <Button type="button" size="xs" variant="secondary" onClick={() => onChange([...items, createItem()])}>Add {label.toLowerCase()}</Button>
    </fieldset>
  )
}

export function PageSeoFields({ editor, editable = true }: { editable?: boolean; editor: {
  seo: PageSeo
  setSeo: Dispatch<SetStateAction<PageSeo>>
  structuredText: string
  setStructuredText: Dispatch<SetStateAction<string>>
  error: string | null
} }) {
  const { seo, setSeo, structuredText, setStructuredText, error } = editor
  const prefix = useId()
  return <fieldset className={cn(styles.form, seoStyles.group)} disabled={!editable}>
    <legend className={styles.label}>Search and document metadata</legend>
    {(['title', 'description', 'canonical'] as const).map((key) => {
      const id = `${prefix}-${key}`
      const label = { title: 'SEO title', description: 'SEO description', canonical: 'Canonical URL' }[key]
      const props = { id, fieldSize: 'sm' as const, value: seo[key] ?? '', onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setSeo((current) => ({ ...current, [key]: event.target.value })) }
      return <div className={styles.field} key={key}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        {key === 'description' ? <Textarea {...props} rows={3} /> : <Input {...props} />}
      </div>
    })}
    <details>
      <summary className={styles.label}>Additional metadata</summary>
      <div className={styles.form}>
        <SeoList<SeoAlternate> label="Language alternatives" items={seo.alternates ?? []}
          fields={[{ key: 'language', label: 'Language tag' }, { key: 'href', label: 'URL' }]}
          createItem={() => ({ id: crypto.randomUUID(), language: '', href: '' })}
          onChange={(alternates) => setSeo((current) => ({ ...current, alternates }))} />
        <SeoList<SeoMeta> label="Metadata" items={seo.meta ?? []}
          fields={[{ key: 'attribute', label: 'Attribute', options: ['name', 'property', 'http-equiv'] }, { key: 'key', label: 'Key' }, { key: 'content', label: 'Content' }, { key: 'media', label: 'Media query' }]}
          createItem={() => ({ id: crypto.randomUUID(), attribute: 'name', key: '', content: '' })}
          onChange={(meta) => setSeo((current) => ({ ...current, meta }))} />
        <SeoList<SeoLink> label="Metadata links" items={seo.links ?? []}
          fields={[{ key: 'rel', label: 'Relation', options: SEO_LINK_RELATIONS }, { key: 'href', label: 'URL' }, { key: 'type', label: 'MIME type' }, { key: 'sizes', label: 'Sizes' }, { key: 'media', label: 'Media query' }]}
          createItem={() => ({ id: crypto.randomUUID(), rel: 'author', href: '' })}
          onChange={(links) => setSeo((current) => ({ ...current, links }))} />
        <div className={styles.field}>
          <label htmlFor={`${prefix}-structured`} className={styles.label}>Structured data (JSON-LD)</label>
          <Textarea id={`${prefix}-structured`} fieldSize="sm" monospace rows={8} value={structuredText}
            onChange={(event) => setStructuredText(event.target.value)} />
          <p className={styles.label}>A JSON array of objects. Native template tokens resolve in string values.</p>
        </div>
      </div>
    </details>
    {error && <p className={styles.errorText} role="alert">{error}</p>}
  </fieldset>
}
