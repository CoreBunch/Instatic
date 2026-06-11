/**
 * Form page-token stamping — the surviving server half of the CMS-form
 * publish path.
 *
 * The browser runtime itself ships through the module-JS channel
 * (`src/modules/base/forms/formRuntimeJs.ts`, emitted by `base.form`'s
 * render() when `mode === 'cms'`, served at `/_instatic/module-js/base.form.js`).
 * What CANNOT travel through render() is the per-page HMAC token — token
 * issuance needs the server signing secret — so `stampFormPageTokens` runs as
 * its own post-render step on every published page (publishedHtmlPipeline)
 * AND on every hole fragment (handleHoleRequest), stamping
 * `data-instatic-page-token` + `data-instatic-page-id` onto each CMS-native
 * `<form>` tag. Tokens are stateless HMAC signatures (no expiry), so baking
 * them into disk artefacts and cached fragments is safe.
 */
import { issuePublicFormPageToken } from './challenge'

const CMS_FORM_TAG_PATTERN = /<form\b(?=[^>]*\bdata-instatic-form-mode=(["'])cms\1)(?=[^>]*\bdata-instatic-form-id=(["'])[^"']+\2)[^>]*>/gi

export function stampFormPageTokens(html: string, pageId: string): string {
  return html.replace(CMS_FORM_TAG_PATTERN, (tag) => {
    if (/\bdata-instatic-page-token=/.test(tag)) return tag
    const formId = attrValue(tag, 'data-instatic-form-id')
    if (!formId) return tag
    const token = issuePublicFormPageToken({ pageId, formId })
    return tag.replace(
      /<form\b/i,
      `<form data-instatic-page-token="${escapeAttr(token)}" data-instatic-page-id="${escapeAttr(pageId)}"`,
    )
  })
}

function attrValue(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i')
  const match = tag.match(pattern)
  return match?.[2] ?? ''
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
