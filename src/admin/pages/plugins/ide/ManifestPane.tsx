/**
 * ManifestPane — the structured `plugin.json` editor (the IDE's right panel).
 *
 * The panel is the PRIMARY manifest surface: name/description fields,
 * a permission checklist (with the dangerous-code warning on editor.code),
 * network allowlist entries, and read-only derived fields (id, active
 * version, detected entrypoints). Raw JSON stays available by opening
 * plugin.json in the editor — the escape hatch, not the default.
 *
 * Writes rewrite the plugin.json file content as a minimal Y.Text splice,
 * so a peer's concurrent manifest edit merges instead of clobbering.
 */
import { useSyncExternalStore, useCallback, useRef, useState } from 'react'
import { safeParseJson } from '@core/utils/jsonValidate'
import {
  SitePluginDraftManifestSchema,
  sitePluginIdFromLocalId,
  type SitePluginDraftManifest,
  type SitePluginSummary,
} from '@core/site-plugins'
import {
  PLUGIN_PERMISSION_VALUES,
  permissionLabel,
  type PluginPermission,
} from '@core/plugin-sdk'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Switch } from '@ui/components/Switch'
import { Separator } from '@ui/components/Separator'
import type { IdeCollabSession, IdeFileMeta } from './ideCollab'
import styles from './ManifestPane.module.css'

interface ManifestPaneProps {
  session: IdeCollabSession
  localId: string
  files: IdeFileMeta[]
  summary: SitePluginSummary | null
  canEdit: boolean
  onOpenRawJson: () => void
}

interface ParsedManifest {
  manifest: SitePluginDraftManifest | null
  error: string | null
  raw: string
}

function parseManifest(raw: string | null): ParsedManifest {
  if (raw === null) {
    return { manifest: null, error: 'plugin.json is missing', raw: '' }
  }
  const result = safeParseJson(raw, SitePluginDraftManifestSchema)
  if (!result.ok) {
    return { manifest: null, error: result.error.message, raw }
  }
  return { manifest: result.value, error: null, raw }
}

export function ManifestPane({
  session,
  localId,
  files,
  summary,
  canEdit,
  onOpenRawJson,
}: ManifestPaneProps) {
  const manifestFile = files.find((file) => file.path.endsWith('/plugin.json')) ?? null
  const manifestFileId = manifestFile?.id ?? null

  // Manifest content is CRDT state — subscribe to the file's text and parse
  // per change (cached snapshot keeps renders referentially stable).
  const parsedCache = useRef<ParsedManifest & { source: string | null }>({
    manifest: null,
    error: 'plugin.json is missing',
    raw: '',
    source: null,
  })
  const subscribe = useCallback(
    (onStoreChange: () => void) => session.onFilesChange(onStoreChange),
    [session],
  )
  const getSnapshot = useCallback((): ParsedManifest => {
    const raw = manifestFileId ? (session.contentText(manifestFileId)?.toString() ?? null) : null
    if (raw !== parsedCache.current.source) {
      parsedCache.current = { ...parseManifest(raw), source: raw }
    }
    return parsedCache.current
  }, [session, manifestFileId])
  const parsed = useSyncExternalStore(subscribe, getSnapshot)

  const [hostDraft, setHostDraft] = useState('')

  const writeManifest = (update: (current: SitePluginDraftManifest) => SitePluginDraftManifest): void => {
    if (!manifestFileId || !parsed.manifest) return
    const next = update(parsed.manifest)
    session.replaceFileContent(manifestFileId, `${JSON.stringify(next, null, 2)}\n`)
  }

  const permissions = parsed.manifest?.permissions ?? []
  const togglePermission = (permission: PluginPermission, enabled: boolean): void => {
    writeManifest((current) => ({
      ...current,
      permissions: enabled
        ? [...(current.permissions ?? []), permission]
        : (current.permissions ?? []).filter((p) => p !== permission),
    }))
  }

  const hosts = parsed.manifest?.networkAllowedHosts ?? []
  const addHost = (): void => {
    const host = hostDraft.trim().toLowerCase()
    if (!host || hosts.includes(host)) return
    writeManifest((current) => ({
      ...current,
      networkAllowedHosts: [...(current.networkAllowedHosts ?? []), host],
    }))
    setHostDraft('')
  }
  const removeHost = (host: string): void => {
    writeManifest((current) => {
      const remaining = (current.networkAllowedHosts ?? []).filter((h) => h !== host)
      const next = { ...current }
      if (remaining.length > 0) next.networkAllowedHosts = remaining
      else delete next.networkAllowedHosts
      return next
    })
  }

  const detectedEntrypoints = detectEntrypoints(files)

  return (
    <div className={styles.pane} data-testid="ide-manifest-pane">
      <header className={styles.header}>
        <h2 className={styles.title}>Manifest</h2>
        <Button variant="ghost" size="xs" onClick={onOpenRawJson}>
          Edit raw JSON
        </Button>
      </header>

      {parsed.error ? (
        <div className={styles.parseError} role="alert">
          <p>plugin.json can’t be edited structurally right now:</p>
          <p className={styles.parseErrorDetail}>{parsed.error}</p>
          <Button variant="secondary" size="sm" onClick={onOpenRawJson}>
            Fix in raw JSON
          </Button>
        </div>
      ) : (
        <div className={styles.sections}>
          <section className={styles.section}>
            <label className={styles.fieldLabel} htmlFor="ide-manifest-name">
              Name
            </label>
            <Input
              id="ide-manifest-name"
              value={parsed.manifest?.name ?? ''}
              disabled={!canEdit}
              onChange={(event) => {
                const name = event.currentTarget.value
                writeManifest((current) => ({ ...current, name }))
              }}
            />
            <label className={styles.fieldLabel} htmlFor="ide-manifest-description">
              Description
            </label>
            <Input
              id="ide-manifest-description"
              value={parsed.manifest?.description ?? ''}
              disabled={!canEdit}
              onChange={(event) => {
                const description = event.currentTarget.value
                writeManifest((current) => ({ ...current, description }))
              }}
            />
          </section>

          <Separator />

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Permissions</h3>
            <p className={styles.sectionHint}>
              Declared here; granted by an operator at Build &amp; activate.
            </p>
            <ul className={styles.permissionList}>
              {PLUGIN_PERMISSION_VALUES.map((permission) => (
                <li key={permission} className={styles.permissionRow}>
                  <Switch
                    checked={permissions.includes(permission)}
                    disabled={!canEdit}
                    onCheckedChange={(checked) => togglePermission(permission, checked)}
                    aria-label={`Permission ${permission}`}
                  />
                  <span className={styles.permissionText}>
                    <span className={styles.permissionId}>{permission}</span>
                    <span className={styles.permissionLabel}>{permissionLabel(permission)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {permissions.includes('editor.code') && (
              <p className={styles.dangerNote} role="note">
                editor.code runs this plugin’s JavaScript unsandboxed in every
                admin’s browser. Operators see a warning before granting it.
              </p>
            )}
          </section>

          <Separator />

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Outbound network hosts</h3>
            <p className={styles.sectionHint}>
              Requires the network.outbound permission. One hostname per entry;
              `*.example.com` matches one subdomain level.
            </p>
            <ul className={styles.hostList}>
              {hosts.map((host) => (
                <li key={host} className={styles.hostRow}>
                  <code className={styles.hostName}>{host}</code>
                  <Button
                    variant="ghost"
                    size="micro"
                    disabled={!canEdit}
                    onClick={() => removeHost(host)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className={styles.hostAdd}>
              <Input
                value={hostDraft}
                placeholder="api.example.com"
                aria-label="Add allowed host"
                disabled={!canEdit}
                onChange={(event) => setHostDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addHost()
                  }
                }}
              />
              <Button variant="secondary" size="xs" disabled={!canEdit || !hostDraft.trim()} onClick={addHost}>
                Add
              </Button>
            </div>
          </section>

          <Separator />

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Derived by the build</h3>
            <dl className={styles.derivedList}>
              <dt>Plugin id</dt>
              <dd>
                <code>{sitePluginIdFromLocalId(localId)}</code>
              </dd>
              <dt>Active version</dt>
              <dd>{summary?.activeVersion ?? 'not built yet'}</dd>
              <dt>Entrypoints</dt>
              <dd>
                {detectedEntrypoints.length > 0 ? detectedEntrypoints.join(', ') : 'none detected'}
              </dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  )
}

function detectEntrypoints(files: IdeFileMeta[]): string[] {
  const relative = files.map((file) => file.path.split('/').slice(2).join('/'))
  const has = (base: string): boolean =>
    ['ts', 'tsx', 'js', 'mjs'].some(
      (ext) => relative.includes(`${base}.${ext}`) || relative.includes(`${base}/index.${ext}`),
    )
  const detected: string[] = []
  if (has('server')) detected.push('server')
  if (has('editor')) detected.push('editor')
  if (relative.some((p) => p.startsWith('modules/') && /\.(tsx?|m?js)$/.test(p))) {
    detected.push('modules')
  }
  if (relative.some((p) => p.startsWith('frontend/'))) detected.push('frontend')
  return detected
}
