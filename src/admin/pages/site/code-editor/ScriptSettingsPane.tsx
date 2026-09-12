import { useId } from 'react'
import { useEditorStore } from '@site/store/store'
import type { SiteFile } from '@core/files/schemas'
import {
  analyzeRuntimeScriptImports,
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  normalizeScriptRuntimeConfig,
  type SiteScriptFormat,
  type SiteScriptPlacement,
  type SiteScriptTiming,
} from '@core/site-runtime'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { AssetScopeControl, type ScopePageOption } from './AssetScopeControl'
import styles from './ScriptSettingsPane.module.css'

interface ScriptSettingsPaneProps {
  file: SiteFile
}

const EMPTY_PAGES: NonNullable<ReturnType<typeof useEditorStore.getState>['site']>['pages'] = []

export function ScriptSettingsPane({ file }: ScriptSettingsPaneProps) {
  const site = useEditorStore((s) => s.site)
  const packageJson = useEditorStore((s) => s.packageJson)
  const siteRuntime = useEditorStore((s) => s.siteRuntime)
  const patchScriptRuntimeConfig = useEditorStore((s) => s.patchScriptRuntimeConfig)
  const runInCanvasId = useId()

  const pages = site?.pages ?? EMPTY_PAGES
  const config = normalizeScriptRuntimeConfig(
    siteRuntime.scripts[file.id] ?? DEFAULT_SCRIPT_RUNTIME_CONFIG,
  )
  const importAnalysis = config.format === 'module'
    ? analyzeRuntimeScriptImports([file], packageJson)
    : { usage: new Map(), diagnostics: [] }
  const runtimePackages = [...importAnalysis.usage.values()]
  const diagnostics = importAnalysis.diagnostics
  const scopeOptions: ScopePageOption[] = pages.map((page) => ({
    id: page.id,
    label: page.title || page.slug || page.id,
    isTemplate: Boolean(page.template),
  }))

  function patch(patchValue: Parameters<typeof patchScriptRuntimeConfig>[1]) {
    patchScriptRuntimeConfig(file.id, patchValue)
  }

  return (
    <aside className={styles.pane} aria-label="Script runtime settings">
      <p className={styles.placementHint}>
        Frontend scripts are standalone page JavaScript. Browser code that
        calls a site plugin’s backend belongs in that plugin’s{' '}
        <code>frontend/</code> assets instead.
      </p>
      <div className={styles.header}>
        <span className={styles.title}>Runtime</span>
        <Button
          variant={config.enabled ? 'secondary' : 'ghost'}
          size="xs"
          pressed={config.enabled}
          onClick={() => patch({ enabled: !config.enabled })}
          aria-label="Script enabled"
        >
          {config.enabled ? 'On' : 'Off'}
        </Button>
      </div>

      <div className={styles.switchRow}>
        <label htmlFor={runInCanvasId}>Run in canvas</label>
        <Switch
          id={runInCanvasId}
          checked={config.runInCanvas}
          onCheckedChange={(checked) => patch({ runInCanvas: checked })}
          switchSize="sm"
          aria-label="Run in canvas"
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Format</span>
        <Select
          aria-label="Script format"
          fieldSize="xs"
          value={config.format}
          onChange={(event) => patch({ format: event.target.value as SiteScriptFormat })}
          options={[
            { value: 'module', label: 'Module' },
            { value: 'classic', label: 'Classic' },
          ]}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Placement</span>
        <Select
          aria-label="Script placement"
          fieldSize="xs"
          value={config.placement}
          onChange={(event) => patch({ placement: event.target.value as SiteScriptPlacement })}
          options={[
            { value: 'body-end', label: 'Body end' },
            { value: 'head', label: 'Head' },
          ]}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Timing</span>
        <Select
          aria-label="Script timing"
          fieldSize="xs"
          value={config.timing}
          onChange={(event) => patch({ timing: event.target.value as SiteScriptTiming })}
          options={[
            { value: 'dom-ready', label: 'DOM ready' },
            { value: 'immediate', label: 'Immediate' },
            { value: 'idle', label: 'Idle' },
          ]}
        />
      </div>

      <AssetScopeControl
        scope={config.scope}
        pages={scopeOptions}
        onChange={(scope) => patch({ scope })}
        ariaLabelPrefix="Script"
      />

      <div className={styles.field}>
        <span className={styles.label}>Priority</span>
        <Input
          aria-label="Script priority"
          fieldSize="xs"
          type="number"
          value={String(config.priority)}
          onChange={(event) => {
            const next = Number(event.target.value)
            patch({ priority: Number.isFinite(next) ? next : DEFAULT_SCRIPT_RUNTIME_CONFIG.priority })
          }}
        />
      </div>

      {(runtimePackages.length > 0 || diagnostics.length > 0) && (
        <div className={styles.imports} aria-label="Script imports">
          {runtimePackages.length > 0 && (
            <div className={styles.importList}>
              {runtimePackages.map((dependency) => (
                <span key={dependency.name} className={styles.importBadge}>
                  {dependency.name}
                </span>
              ))}
            </div>
          )}
          {diagnostics.map((diagnostic) => (
            <div
              key={`${diagnostic.code}:${diagnostic.packageName ?? diagnostic.message}`}
              className={styles.diagnostic}
              data-severity={diagnostic.severity}
            >
              {diagnostic.packageName ?? diagnostic.message}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
