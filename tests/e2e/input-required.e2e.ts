import { expect, test, type Locator } from '@playwright/test'
import { createPage, insertModuleViaPicker, openSiteEditor, openSitePanel } from './helpers'

/**
 * ADMIN-018: the bind-to-data affordance never covers a property control.
 * It used to be laid over the top right of every bindable control, where it
 * took the click meant for a toggle's switch, a number's stepper, or the
 * Page segment of a URL control.
 */

/**
 * Centre the control (clear of toasts at the panel's foot), hover its row,
 * then check the control's own top-right corner is the control.
 */
async function expectCornerReachable(control: Locator): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await control.hover()
  const atCorner = await control.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.right - 3, box.top + 3)
    return hit !== null && (hit === element || element.contains(hit)) ? 'control' : hit?.outerHTML.slice(0, 120) ?? 'nothing'
  })
  expect(atCorner).toBe('control')
}

test('the bind affordance never covers a property control (ADMIN-018)', async ({ page }) => {
  await openSiteEditor(page)
  const suffix = Date.now().toString(36)
  const name = `Bind affordance ${suffix}`
  await createPage(page, name, `bind-affordance-${suffix}`)
  await openSitePanel(page)
  await page.getByRole('treeitem', { name: `Open page ${name}` }).click()

  await insertModuleViaPicker(page, 'base.form')
  await insertModuleViaPicker(page, 'base.input')

  await test.step('toggle: the Required switch turns on and off', async () => {
    const required = page.locator('#ctrl-required')
    await expect(page.getByRole('button', { name: 'Bind Required' })).toBeAttached()
    await expect(required).toHaveAttribute('aria-checked', 'false')
    await required.click()
    await expect(required).toHaveAttribute('aria-checked', 'true')
    await required.click()
    await expect(required).toHaveAttribute('aria-checked', 'false')
  })

  await test.step('number: the stepper corner stays on the input', async () => {
    await expect(page.getByRole('button', { name: 'Bind Minimum length' })).toBeAttached()
    await expectCornerReachable(page.locator('#ctrl-minLength'))
  })

  await test.step('url: the Page segment takes its click', async () => {
    await insertModuleViaPicker(page, 'base.link')
    await expect(page.getByRole('button', { name: /binding for URL|Bind URL/ })).toBeAttached()
    const pageSegment = page.getByRole('radio', { name: 'Page' }).or(page.getByRole('button', { name: 'Page', exact: true })).first()
    await expectCornerReachable(pageSegment)
    await pageSegment.click({ position: { x: (await pageSegment.boundingBox())!.width - 4, y: 4 } })
    await expect(page.locator('#ctrl-href')).toBeVisible()
    await expect(page.locator('#ctrl-href')).toHaveAttribute('role', 'combobox')
  })
})
