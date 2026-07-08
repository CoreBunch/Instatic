/**
 * Container healthcheck — used by both the Dockerfile HEALTHCHECK and
 * compose.prod.yml's `healthcheck:` block.
 *
 * The base oven/bun image is slim and ships neither `curl` nor `wget`, so we
 * use Bun's built-in fetch instead. Extracting this into a small script keeps
 * the YAML/Dockerfile readable (no JSON-escaped JS one-liners) and makes the
 * healthcheck logic discoverable in the codebase.
 */
import { DEFAULT_CMS_PORT } from './config'

const port = process.env.PORT ?? String(DEFAULT_CMS_PORT)
const url = `http://127.0.0.1:${port}/health`

try {
  const res = await fetch(url)
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}
