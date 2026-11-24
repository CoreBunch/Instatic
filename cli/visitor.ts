import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { resolve } from 'node:path'
import { openChromium, parseViewport } from './browser'

const text = Type.String({ minLength: 1, maxLength: 4096 })
const action = Type.Union([
  Type.Object({ fill: text, value: Type.String({ maxLength: 16000 }) }, { additionalProperties: false }),
  Type.Object({ fillLabel: text, value: Type.String({ maxLength: 16000 }) }, { additionalProperties: false }),
  Type.Object({ clickLink: text }, { additionalProperties: false }),
  Type.Object({ expectText: text }, { additionalProperties: false }),
  Type.Object({ expectHidden: text }, { additionalProperties: false }),
  Type.Object({ expectPath: text }, { additionalProperties: false }),
])
const actionsSchema = Type.Array(action, { maxItems: 40 })

function publicRoute(url: URL, origin: string) {
  return url.origin === origin && !url.username && !url.password && !/^\/(admin|_instatic)(\/|$)/.test(url.pathname)
}

export async function visit(origin: string, path: string, options: { viewport?: string; out?: string }, actions: unknown,
  render: (path: string) => Promise<string>) {
  if (!Value.Check(actionsSchema, actions)) throw new Error('Expected a JSON array of visit steps. See instatic --help.')
  if (!path?.startsWith('/') || path.startsWith('//') || !publicRoute(new URL(path, origin), origin)) throw new Error('Use a public site-relative path')
  const viewport = parseViewport(options.viewport)
  const browser = await openChromium()
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: false })
    context.setDefaultTimeout(6000)
    let page = await context.newPage()
    const errors: string[] = []
    let blockedRequests = 0
    const navigationErrors = new Map<string, string>()
    const documentError = () => navigationErrors.get(page.url().split('#')[0])
    context.on('weberror', event => { if (errors.length < 10) errors.push(event.error().message) })
    await context.routeWebSocket('**/*', socket => socket.close())
    await context.route('**/*', async route => {
      const req = route.request()
      const url = new URL(req.url())
      if (req.method() === 'GET' && req.isNavigationRequest() && publicRoute(url, origin)) {
        try {
          navigationErrors.delete(req.url())
          const html = await render(url.pathname + url.search)
          return await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
        } catch (err) {
          navigationErrors.set(req.url(), err instanceof Error ? err.message : String(err))
          return route.fulfill({ status: 502, body: 'Branch preview unavailable' })
        }
      }
      if (!req.isNavigationRequest() && req.method() === 'GET' && url.origin === origin &&
        !/^\/admin(\/|$)/.test(url.pathname) && ['stylesheet', 'font', 'image', 'media', 'script'].includes(req.resourceType())) {
        const asset = await route.fetch({ maxRedirects: 0, timeout: 10000 }).catch(() => null)
        if (asset?.ok()) return route.fulfill({ response: asset })
      }
      blockedRequests++
      return route.abort()
    })
    const shot = options.out && resolve(options.out)
    const screenshot = async () => { if (shot) await page.screenshot({ path: shot, type: 'png' }) }
    let step = 0
    try {
      await page.goto(new URL(path, origin).href, { waitUntil: 'load' })
      if (documentError()) throw new Error(documentError())
      for (const item of actions) {
        step++
        if ('fill' in item) await page.locator(item.fill).fill(item.value)
        else if ('fillLabel' in item) await page.getByLabel(item.fillLabel, { exact: true }).fill(item.value)
        else if ('clickLink' in item) {
          const link = page.getByRole('link', { name: item.clickLink, exact: true })
          const href = await link.getAttribute('href')
          if (!href || !publicRoute(new URL(href, page.url()), origin)) throw new Error('Link must lead to a public route on this installation')
          const target = await link.getAttribute('target')
          if (target?.toLowerCase() === '_blank') {
            const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()])
            page = popup
          } else await link.click()
          await page.waitForLoadState('load')
        }
        else if ('expectPath' in item) await page.waitForURL(url => url.origin === origin && url.pathname + url.search + url.hash === item.expectPath)
        else {
          const visible = 'expectText' in item
          const locator = page.getByText(visible ? item.expectText : item.expectHidden, { exact: true }).filter({ visible: true }).first()
          await locator.waitFor({ state: visible ? 'visible' : 'hidden' })
        }
        if (documentError()) throw new Error(documentError())
      }
      await screenshot()
      const url = new URL(page.url())
      if (!publicRoute(url, origin)) throw new Error('Navigation left the public branch preview')
      return { path: url.pathname + url.search + url.hash, viewport, stepsPassed: step, screenshot: shot,
        text: (await page.locator('body').innerText()).slice(0, 8000),
        fields: await page.locator('input:visible,textarea:visible').evaluateAll(elements => elements.slice(0, 60).map(element => ({
          id: element.id, name: element.getAttribute('name'), type: element.getAttribute('type'),
          placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label') ??
            (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.labels?.[0]?.textContent?.trim() : undefined),
        }))),
        links: await page.getByRole('link').evaluateAll(links => links.slice(0, 100).map(link => ({ text: link.textContent?.trim(), href: link.getAttribute('href') }))),
        blockedRequests, errors }
    } catch (err) {
      await screenshot().catch(() => undefined)
      throw new Error('Visit failed ' + (step ? 'at step ' + step : 'opening ' + path) + ': ' +
        (documentError() || (err instanceof Error ? err.message : String(err))) + (shot ? '\nScreenshot: ' + shot : ''), { cause: err })
    }
  } finally { await browser.close() }
}
