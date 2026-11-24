import { Type, type Static } from '@sinclair/typebox'
import type { Page } from 'playwright-core'

export const CanvasSnapshotSchema = Type.Object({
  id: Type.String(), slug: Type.String(), access: Type.Object({ level: Type.String() }),
  revision: Type.String(), html: Type.String(),
  nodes: Type.Array(Type.Object({
    uid: Type.String(), node: Type.Union([Type.String(), Type.Null()]), module: Type.String(),
    classes: Type.Optional(Type.Array(Type.String())), inline: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  })),
  rules: Type.Array(Type.Object({
    id: Type.String(), selector: Type.String(), styles: Type.Record(Type.String(), Type.Unknown()),
    contexts: Type.Record(Type.String(), Type.Unknown()), pages: Type.Array(Type.String()), components: Type.Array(Type.String()),
  })),
  contexts: Type.Array(Type.Object({ id: Type.String() })),
})

export async function inspectViewport(page: Page, snapshot: Static<typeof CanvasSnapshotSchema>, focus?: string) {
  const geometry = await page.locator('[uid]').evaluateAll(elements => elements.flatMap(el => {
    if (!(el instanceof HTMLElement) || getComputedStyle(el).visibility === 'hidden') return []
    const box = el.getBoundingClientRect()
    if (!box.width || !box.height || box.bottom <= 0 || box.top >= window.innerHeight) return []
    const range = document.createRange()
    range.selectNodeContents(el)
    const contents = range.getBoundingClientRect()
    const right = Math.max(contents.right, box.right)
    const left = Math.min(contents.left, box.left)
    const overflow = Math.ceil(Math.max(0, right - window.innerWidth, -left))
    return [{
      uid: el.getAttribute('uid')!, tag: el.localName,
      text: el.innerText?.trim().slice(0, 150),
      bounds: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      ...(overflow ? { horizontalOverflowPx: overflow, whiteSpace: getComputedStyle(el).whiteSpace } : {}),
    }]
  }))
  const source = new Map(snapshot.nodes.map(node => [node.uid, node]))
  const visible = geometry.map(hit => {
    const entry = source.get(hit.uid)
    return { ...hit, node: entry?.node ?? null, module: entry?.module, classes: entry?.classes, inline: entry?.inline }
  }).filter(hit => !focus || hit.node === focus || hit.uid === focus)
  const shown = visible.slice(0, 100)
  const ruleIds = new Set(shown.flatMap(hit => hit.classes ?? []))
  return {
    id: snapshot.id, slug: snapshot.slug, access: snapshot.access,
    forms: await page.locator('form').evaluateAll(forms => forms.filter((form): form is HTMLFormElement => form instanceof HTMLFormElement).map(form => ({
      action: form.getAttribute('action'), method: form.method,
      fields: Array.from(form.elements, el => el.getAttribute('name')).filter(Boolean),
      success: form.querySelector<HTMLInputElement>('input[name="_success"]')?.value || form.getAttribute('data-instatic-success-redirect'),
    }))),
    revision: snapshot.revision, visibleCount: visible.length, nodes: shown,
    rules: snapshot.rules.filter(rule => ruleIds.has(rule.id)), contexts: snapshot.contexts,
    ...(visible.length > shown.length ? { truncated: true } : {}),
  }
}
