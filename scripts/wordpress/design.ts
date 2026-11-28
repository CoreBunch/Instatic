import { PUBLISHER_RESET_CSS } from '@core/publisher'
import type { FileMap } from '@core/siteImport'
import { fieldId, mappedField, objectId, tableId } from './model'
import type { Mapping, Source } from './source'

const encode = new TextEncoder()
const decode = new TextDecoder()
type PageSpec = { file: string; doc: Document; post?: number; entry?: string; shared?: boolean }

export function design(source: Source, sourceFiles: FileMap['files'], mapping: Mapping, warnings: Set<string>) {
  const files: FileMap['files'] = Object.create(null)
  const pages = new Map<string, PageSpec>()
  const bodies = new Map<number, string>()
  const site = new URL(source.site)
  const stylesheetModes: Record<string, 'file'> = {}
  function local(value: string, base: string) {
    if (!value || /^(?:#|data:|blob:|mailto:|tel:|\{)/i.test(value)) return value
    let url: URL
    try { url = new URL(value, base) } catch { return value }
    if (url.origin !== site.origin) return value
    return url.pathname + url.search + url.hash
  }
  function css(text: string, base: string) {
    return text.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (_all, _quote, value: string) => 'url("' + local(value.trim(), base) + '")')
  }
  for (const [key, asset] of Object.entries(sourceFiles)) {
    if (!key.startsWith('assets/')) continue
    const path = key.slice(7)
    if (/\.css$/i.test(path)) {
      files[path] = { bytes: encode.encode(css(decode.decode(asset.bytes), new URL('/' + path, site).href)), mimeType: 'text/css' }
      stylesheetModes[path] = 'file'
    } else if (!/\.m?js$/i.test(path) || mapping.scripts?.includes('/' + path)) files[path] = asset
  }
  // Match the source browser's UA defaults before applying the theme. Only
  // undo properties from the publisher's zero-specificity reset.
  const baseline = 'wp-migration/browser-defaults.css'
  if (Object.hasOwn(files, baseline)) throw new Error('Reserved migration stylesheet path: ' + baseline)
  // The controlled reset consists of flat declarations. Transform its source
  // because the offline DOM's CSSOM silently drops vendor font smoothing.
  const baselineCss = PUBLISHER_RESET_CSS.replace(/([;{]\s*[-\w]+\s*:)[^;{}]+/g, '$1 revert')
  files[baseline] = { bytes: encode.encode(baselineCss), mimeType: 'text/css' }
  stylesheetModes[baseline] = 'file'

  function marker(doc: Document, element: Element, name: string) {
    const replacement = doc.createElement(name)
    for (const attr of element.attributes) replacement.setAttribute(attr.name, attr.value)
    replacement.setAttribute('data-tag', element.localName)
    element.replaceWith(replacement)
    return replacement
  }
  function documentFor(html: string, url: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    for (const script of doc.querySelectorAll('script:not([type="application/ld+json"])')) {
      const src = script.getAttribute('src')
      if (src) {
        const scriptUrl = new URL(src, url)
        if (scriptUrl.origin === site.origin && mapping.scripts?.includes(scriptUrl.pathname) && files[scriptUrl.pathname.slice(1)]) continue
      }
      warnings.add('Script requires behavior review: ' + (script.getAttribute('src') || script.id || 'inline at ' + url))
      script.remove()
    }
    for (const el of doc.querySelectorAll('base, link[rel="https://api.w.org/"], link[rel="EditURI"], link[rel="shortlink"], link[type="application/json+oembed"], link[type="text/xml+oembed"]')) el.remove()
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of ['href', 'src', 'poster', 'action', 'content']) {
        const value = el.getAttribute(attr)
        if (value && (attr !== 'content' || value.startsWith(site.origin + '/'))) el.setAttribute(attr, local(value, url))
      }
      const set = el.getAttribute('srcset')
      if (set && !set.includes('data:')) el.setAttribute('srcset', set.split(',').map(v => {
        const [path, ...descriptor] = v.trim().split(/\s+/)
        return [local(path, url), ...descriptor].join(' ')
      }).join(', '))
      if (el.hasAttribute('style')) el.setAttribute('style', css(el.getAttribute('style')!, url))
      if (el.tagName === 'STYLE') el.textContent = css(el.textContent ?? '', url)
    }
    for (const form of doc.querySelectorAll('form')) {
      const match = mapping.forms?.find(f => form.matches(f.selector))
      if (!match) { warnings.add('Unmapped form at ' + url); continue }
      const controls = Array.from(form.querySelectorAll('input[name], textarea[name], select[name]'))
      for (const control of controls) {
        const name = control.getAttribute('name')!
        if (!Object.hasOwn(match.fields, name)) throw new Error('Form ' + match.name + ' has unmapped field ' + name)
      }
      form.setAttribute('data-instatic-form-mode', 'cms')
      form.setAttribute('data-instatic-target-table', objectId(source, 'form', match.name))
      form.removeAttribute('action')
      form.setAttribute('method', 'post')
    }
    return doc
  }
  function add(file: string, doc: Document, metadata: Omit<PageSpec, 'file' | 'doc'> = {}) {
    if (pages.has(file) || Object.hasOwn(files, file)) throw new Error('Two sources own ' + file)
    pages.set(file, { file, doc, ...metadata })
  }
  function route(url: string) {
    const u = new URL(url)
    if (u.search) throw new Error('The pilot requires pretty permalinks: ' + url)
    if (u.pathname.replace(/\/$/, '') === site.pathname.replace(/\/$/, '')) return 'index.html'
    const path = u.pathname.replace(/^\/+|\/+$/g, '')
    return path ? path + '/index.html' : 'index.html'
  }
  if (!source.homeHtml) throw new Error('Source homepage could not be captured')
  add('index.html', documentFor(source.homeHtml, source.site))
  const blogArchive = source.types.find(t => t.name === 'post' && t.archiveHtml)?.archive
  for (const type of source.types) {
    const options = mapping.types?.[type.name]
    const publicPosts = source.posts.filter(p => p.public && p.type === type.name)
    let template: Document | undefined
    let templateBody: string | undefined
    for (const p of publicPosts) {
      if (!p.html) throw new Error('Missing public document for ' + p.url)
      const doc = documentFor(p.html, p.url)
      if (p.type === 'page') {
        const file = route(p.url)
        if (blogArchive && route(blogArchive) === file) continue
        if (file === 'index.html') pages.get(file)!.post = p.id
        else add(file, doc, { post: p.id })
        continue
      }
      const title = doc.querySelector(options?.title ?? '.wp-block-post-title, .entry-title, h1')
      const content = doc.querySelector(options?.body ?? '.wp-block-post-content, .entry-content')
      if (!title || !content || title.contains(content) || content.contains(title)) throw new Error('Supply distinct title and body selectors for ' + p.url)
      bodies.set(p.id, content.innerHTML)
      title.textContent = '{currentEntry.title}'
      marker(doc, content, 'instatic-outlet')
      for (const [name, selector] of Object.entries(options?.text ?? {})) {
        const f = type.fields.find(f => f.name === name)
        const mapped = f && mappedField(source, f)
        if (!mapped || !['text','longText','number','email','url'].includes(mapped.type)) throw new Error('Invalid text binding ' + name)
        const el = doc.querySelector(selector)
        if (!el) throw new Error('Missing text binding ' + selector + ' at ' + p.url)
        el.textContent = '{currentEntry.' + fieldId(name) + '}'
      }
      for (const [name, selector] of Object.entries(options?.gallery ?? {})) {
        if (!type.fields.some(f => f.name === name && f.type === 'gallery')) throw new Error('Unknown gallery ' + name)
        const el = doc.querySelector(selector)
        if (!el) throw new Error('Missing gallery ' + selector + ' at ' + p.url)
        const sample = el.querySelector('img')
        const loop = marker(doc, el, 'instatic-loop')
        loop.setAttribute('data-source-id', 'entry.field')
        loop.setAttribute('data-field-id', fieldId(name))
        loop.setAttribute('data-limit', '1000')
        const image = doc.createElement('img')
        if (sample?.className) image.className = sample.className
        image.setAttribute('src', '{currentEntry.src}')
        image.setAttribute('alt', '{currentEntry.altText}')
        loop.append(image)
      }
      if (!template) { template = doc; templateBody = doc.body.innerHTML }
      else if (doc.body.innerHTML !== templateBody) warnings.add(p.url + ': entry markup differs from the first template after binding; review variants')
    }
    if (template) add('wp-template-' + type.name + '/index.html', template, { entry: type.name })
    if (type.archiveHtml && type.archive) {
      const doc = documentFor(type.archiveHtml, type.archive)
      const list = doc.querySelector(options?.listing ?? '.wp-block-post-template, .posts-list')
      if (!list) throw new Error('Supply an archive listing selector for ' + type.archive)
      const loop = marker(doc, list, 'instatic-loop')
      loop.setAttribute('data-source-id', 'data.rows')
      loop.setAttribute('data-table-id', tableId(source, type.name))
      loop.setAttribute('data-limit', String(Math.max(publicPosts.length + 1, 100)))
      const first = list.firstElementChild?.cloneNode(true)
      const card = first instanceof Element ? first : doc.createElement('article')
      const link = card.matches('a') ? card : card.querySelector('a') ?? doc.createElement('a')
      link.setAttribute('href', '{currentEntry.permalink}')
      link.textContent = '{currentEntry.title}'
      if (!card.contains(link)) card.append(link)
      // A sample's other fields cannot be repeated as if they belong to every entry.
      if (link !== card && (card.querySelectorAll('a').length !== 1 || card.textContent?.trim() !== '{currentEntry.title}' || card.querySelector('img'))) {
        warnings.add('Archive card simplified to a title link at ' + type.archive)
        card.replaceChildren(link)
      }
      loop.append(card)
      const file = route(type.archive)
      if (file === 'index.html' && type.name === 'post') pages.delete(file)
      add(file, doc, { post: source.posts.find(p => p.type === 'page' && p.public && route(p.url) === file)?.id })
    }
  }
  const docs = [...pages.values()].map(p => p.doc)
  const header = docs[0].body.firstElementChild
  const footer = docs[0].body.lastElementChild
  if (header?.tagName === 'HEADER' && footer?.tagName === 'FOOTER' && docs.every(d =>
    d.body.firstElementChild?.outerHTML === header.outerHTML && d.body.lastElementChild?.outerHTML === footer.outerHTML)) {
    const shared = new DOMParser().parseFromString('<html><head><title>Shared layout</title></head><body></body></html>', 'text/html')
    shared.body.append(header.cloneNode(true), shared.createElement('instatic-outlet'), footer.cloneNode(true))
    for (const d of docs) { d.body.firstElementChild!.remove(); d.body.lastElementChild!.remove() }
    add('wp-shared-layout/index.html', shared, { shared: true })
  }
  for (const page of pages.values()) {
    const link = page.doc.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('href', '/' + baseline)
    page.doc.head.prepend(link)
    files[page.file] = { bytes: encode.encode(page.doc.documentElement.outerHTML), mimeType: 'text/html' }
  }
  return { files, pages, bodies, stylesheetModes }
}
