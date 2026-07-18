import { isAbsolute, relative, resolve } from 'node:path'

interface ArtifactRoute {
  path: string
  file: string
  kind: 'page' | 'content' | 'notFound'
}

interface ArtifactManifest {
  schemaVersion: 1
  artifactId: string
  siteId: string
  publishedAt: string
  publishVersion: number
  routes: ArtifactRoute[]
  uploadedFiles: Array<{ publicPath: string; storagePath: string }>
  runtimePackageCache?: { hash: string }
  deployment: {
    mode: 'static'
    portable: boolean
    requirements: Array<{ code: string; message: string }>
  }
}

interface SiteRuntimeOptions {
  artifactDir: string
  manifest: ArtifactManifest
}

const MANIFEST_RELATIVE_PATH = '.instatic/site-artifact.json'

export async function loadArtifactManifest(artifactDir: string): Promise<ArtifactManifest> {
  const file = Bun.file(resolve(artifactDir, MANIFEST_RELATIVE_PATH))
  if (!(await file.exists())) throw new Error(`Site artifact manifest not found in ${artifactDir}`)
  const value: unknown = await file.json()
  if (!isArtifactManifest(value)) throw new Error('Site artifact manifest is invalid or unsupported')
  return value
}

export function createSiteRuntime(options: SiteRuntimeOptions): (req: Request) => Promise<Response> {
  const artifactDir = resolve(options.artifactDir)
  const routeFiles = new Map(
    options.manifest.routes.map((route) => [normalizeRoutePath(route.path), route.file]),
  )
  const notFoundFile = options.manifest.routes.find((route) => route.kind === 'notFound')?.file

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        artifactId: options.manifest.artifactId,
        portable: options.manifest.deployment.portable,
      })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      })
    }

    const safePath = decodePublicPath(url.pathname)
    if (safePath === null || isPrivatePath(safePath)) {
      return await notFoundResponse(artifactDir, notFoundFile, req.method === 'HEAD')
    }

    const routeFile = routeFiles.get(normalizeRoutePath(url.pathname))
    if (routeFile) return await fileResponse(artifactDir, routeFile, req)

    if (isUnsupportedDynamicPath(url.pathname)) {
      return jsonResponse(
        {
          error: 'This exported site uses a dynamic feature that is not available in the static runtime.',
          requirements: options.manifest.deployment.requirements,
        },
        501,
      )
    }

    if (safePath && !safePath.endsWith('/')) {
      const asset = Bun.file(resolveWithin(artifactDir, safePath))
      if (await asset.exists()) return responseForFile(asset, safePath, req)
    }
    return await notFoundResponse(artifactDir, notFoundFile, req.method === 'HEAD')
  }
}

async function fileResponse(
  artifactDir: string,
  relativePath: string,
  req: Request,
): Promise<Response> {
  const file = Bun.file(resolveWithin(artifactDir, relativePath))
  if (!(await file.exists())) return new Response('Not found', { status: 404 })
  return responseForFile(file, relativePath, req)
}

function responseForFile(file: ReturnType<typeof Bun.file>, relativePath: string, req: Request): Response {
  const headers = new Headers({
    'content-type': contentTypeForPath(relativePath),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cache-control': relativePath.endsWith('.html')
      ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=31536000, immutable',
  })

  const range = req.headers.get('range')
  if (range && !relativePath.endsWith('.html')) {
    const parsed = parseByteRange(range, file.size)
    if (!parsed) {
      headers.set('content-range', `bytes */${file.size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('accept-ranges', 'bytes')
    headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${file.size}`)
    headers.set('content-length', String(parsed.end - parsed.start + 1))
    return new Response(
      req.method === 'HEAD' ? null : file.slice(parsed.start, parsed.end + 1).stream(),
      { status: 206, headers },
    )
  }

  headers.set('content-length', String(file.size))
  return new Response(req.method === 'HEAD' ? null : file.stream(), { status: 200, headers })
}

async function notFoundResponse(
  artifactDir: string,
  relativePath: string | undefined,
  head: boolean,
): Promise<Response> {
  if (!relativePath) return new Response(head ? null : 'Not found', { status: 404 })
  const file = Bun.file(resolveWithin(artifactDir, relativePath))
  if (!(await file.exists())) return new Response(head ? null : 'Not found', { status: 404 })
  return new Response(head ? null : file.stream(), {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  })
}

function normalizeRoutePath(pathname: string): string {
  if (pathname === '/') return '/'
  return pathname.replace(/\/+$/g, '')
}

function decodePublicPath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const stripped = decoded.replace(/^\/+/, '').replace(/\\/g, '/')
  if (stripped.split('/').some((segment) => segment === '..')) return null
  return stripped
}

function isPrivatePath(path: string): boolean {
  return path === '.instatic' || path.startsWith('.instatic/') ||
    path === 'admin' || path.startsWith('admin/') ||
    path === 'api' || path.startsWith('api/')
}

function resolveWithin(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`Unsafe public path: ${relativePath}`)
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Public path escapes artifact: ${relativePath}`)
  return target
}

function isUnsupportedDynamicPath(pathname: string): boolean {
  return pathname.startsWith('/_instatic/hole/') ||
    pathname.startsWith('/_instatic/loop/') ||
    pathname.startsWith('/_instatic/form/') ||
    pathname.startsWith('/_instatic/media/')
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0) return null
  const [, startRaw, endRaw] = match
  if (!startRaw && !endRaw) return null
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startRaw)
  const end = endRaw ? Number(endRaw) : size - 1
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}

function contentTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  }
  return types[extension] ?? 'application/octet-stream'
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

function isArtifactManifest(value: unknown): value is ArtifactManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Record<string, unknown>
  if (manifest.schemaVersion !== 1 || !isNonEmptyString(manifest.artifactId)) return false
  if (!isNonEmptyString(manifest.siteId) || !isIsoTimestamp(manifest.publishedAt)) return false
  if (typeof manifest.publishVersion !== 'number' ||
    !Number.isInteger(manifest.publishVersion) || manifest.publishVersion < 1) return false
  if (!Array.isArray(manifest.routes) || !Array.isArray(manifest.uploadedFiles)) return false
  if (manifest.runtimePackageCache !== undefined) {
    if (!manifest.runtimePackageCache || typeof manifest.runtimePackageCache !== 'object' ||
      Array.isArray(manifest.runtimePackageCache)) return false
    const cache = manifest.runtimePackageCache as Record<string, unknown>
    if (typeof cache.hash !== 'string' || !/^[a-f0-9]{24}$/.test(cache.hash)) return false
  }
  if (!manifest.deployment || typeof manifest.deployment !== 'object') return false
  const deployment = manifest.deployment as Record<string, unknown>
  if (deployment.mode !== 'static' || typeof deployment.portable !== 'boolean') return false
  if (!Array.isArray(deployment.requirements) || !deployment.requirements.every(isRequirement)) {
    return false
  }
  if (!manifest.uploadedFiles.every((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false
    const item = file as Record<string, unknown>
    return typeof item.publicPath === 'string' && item.publicPath.startsWith('/uploads/') &&
      typeof item.storagePath === 'string' && isSafeRelativePath(item.storagePath)
  })) return false
  return manifest.routes.every((route) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) return false
    const item = route as Record<string, unknown>
    return typeof item.path === 'string' && item.path.startsWith('/') &&
      typeof item.file === 'string' && isSafeRelativePath(item.file) &&
      (item.kind === 'page' || item.kind === 'content' || item.kind === 'notFound')
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/.test(value)
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..')
}

function isRequirement(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return isNonEmptyString(item.code) && isNonEmptyString(item.message)
}

if (import.meta.main) {
  const artifactDir = resolve(process.env.SITE_ARTIFACT_DIR ?? './public')
  const manifest = await loadArtifactManifest(artifactDir)
  const port = Number.parseInt(process.env.PORT ?? '3000', 10)
  Bun.serve({ port, fetch: createSiteRuntime({ artifactDir, manifest }) })
  console.log(`[site-runtime] Serving artifact ${manifest.artifactId} on http://localhost:${port}`)
}
