/**
 * Content version for a served script body: a short SHA-256 of the bytes.
 *
 * Stamped as `?v=` on the tags that reference `/_instatic/module-js/<id>.js`
 * and `/_instatic/hole-runtime.js`, so the URL changes exactly when the body
 * does. It is derived from the body alone: it survives a restart (unlike the
 * process-local `publishVersion`) and changes on a CMS upgrade that ships a
 * new script (unlike the site snapshot hash).
 */
import { createHash } from 'node:crypto'

export function assetContentVersion(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12)
}
