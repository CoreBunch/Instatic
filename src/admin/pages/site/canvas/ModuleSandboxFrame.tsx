import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnyModuleDefinition } from '@core/module-engine'
import {
  createModuleImportMap,
  getMissingModuleDependencies,
  normalizeModuleDependencies,
} from '@core/module-engine'
import type { SiteDocument } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { FocusedPanel } from '@site/store/slices/uiSlice'
import { Button } from '@ui/components/Button'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { cn } from '@ui/cn'
import { generateClassCSS } from '@core/publisher'
import {
  createSandboxSrcDoc,
  HOST_MESSAGE_SOURCE,
  SANDBOX_MESSAGE_SOURCE,
  type SandboxContext,
} from './moduleSandboxSrcDoc'
import styles from './ModuleSandboxFrame.module.css'

interface ModuleSandboxFrameProps {
  moduleDefinition: AnyModuleDefinition
  props: Record<string, unknown>
  nodeId: string
  isSelected: boolean
  mcClassName?: string
  classIds?: readonly string[]
}

function getNodeClassCSS(site: SiteDocument | null, classIds: readonly string[] | undefined): string {
  if (!site || !classIds?.length) return ''

  const classes: SiteDocument['styleRules'] = {}
  for (const id of classIds) {
    const cls = site.styleRules[id]
    if (cls) classes[id] = cls
  }

  if (Object.keys(classes).length === 0) return ''
  return generateClassCSS(classes, site.breakpoints, site.conditions ?? [])
}

export function ModuleSandboxFrame({
  moduleDefinition,
  props,
  nodeId,
  isSelected,
  mcClassName,
  classIds,
}: ModuleSandboxFrameProps) {
  const site = useEditorStore((s) => s.site)
  const packageJson = useEditorStore((s) => s.packageJson)
  const selectNode = useEditorStore((s) => s.selectNode)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const setDependency = useEditorStore((s) => s.setDependency)
  const setDependenciesPanelOpen = useEditorStore((s) => s.setDependenciesPanelOpen)
  const runtime = moduleDefinition.editorRuntime?.sandbox

  // Dependencies the module declares but the site hasn't installed yet.
  // The iframe's import map is built with `strictSiteManifest: true` —
  // missing deps would surface as a raw `TypeError: Failed to resolve
  // module specifier` inside the iframe. Show a friendlier empty state
  // (with a one-click "add" affordance) before mounting the iframe at all.
  const missingDependencies = getMissingModuleDependencies(moduleDefinition, packageJson)

  const classCSS = getNodeClassCSS(site, classIds)

  // The iframe's import map is filtered from the site's precomputed
  // `runtime.packageImportmap` — the server built it from the actual
  // `bun install` cache when the user resolved their deps, so the URLs
  // point at the host's own `/_instatic/runtime/cache/...` route. Plugin code
  // never names a CDN: `import * as THREE from 'three'` resolves to the
  // same on-disk file the published page uses.
  const siteImportmap = useEditorStore((s) => s.siteRuntime.packageImportmap)
  const dependencyResolveStatus = useEditorStore((s) => s.dependencyResolveStatus)
  const importMap = createModuleImportMap(moduleDefinition, {
    packageJson,
    strictSiteManifest: true,
    siteImportmap,
  })
  // Importmap is incomplete if any runtime dep declared by this module is
  // missing from `importMap.imports`. That's the case after opening a site
  // whose persisted state predates the importmap field, or while the
  // background auto-resolve is still installing. We refuse to mount the
  // iframe in that state so the user sees a clear "resolving" message
  // instead of a "Failed to resolve module specifier" runtime error.
  const importmapIncomplete = (() => {
    const runtimeDeps = normalizeModuleDependencies(moduleDefinition.dependencies)
      .filter((dep) => !dep.dev)
    if (runtimeDeps.length === 0) return false
    return runtimeDeps.some((dep) => !importMap.imports[dep.name])
  })()

  const sandboxContext: SandboxContext = {
    props,
    nodeId,
    isSelected,
    className: mcClassName ?? '',
    dependencies: importMap.imports,
    apiVersion: 1,
  }

  if (!runtime) {
    return (
      <div className={styles.fallback}>
        Missing sandbox runtime for {moduleDefinition.name}
      </div>
    )
  }

  // Importmap not yet populated for this module's runtime deps —
  // `useAutoResolveDependencies` triggers a fresh resolve in the
  // background; mount nothing until the URLs land.
  if (importmapIncomplete && missingDependencies.length === 0) {
    const status = dependencyResolveStatus === 'error'
      ? 'Dependency resolve failed — open the Dependencies panel to retry.'
      : 'Resolving runtime packages…'
    return (
      <CanvasModulePlaceholder
        className={mcClassName}
        icon={<PackageSolidIcon size={16} color="currentColor" />}
        label={`${moduleDefinition.name} is preparing`}
        description={status}
      />
    )
  }

  if (missingDependencies.length > 0) {
    const packagesLabel = missingDependencies
      .map((dep) => `${dep.name}@${dep.version}`)
      .join(', ')
    const buttonLabel = missingDependencies.length === 1
      ? `Add ${missingDependencies[0]!.name}`
      : `Add ${missingDependencies.length} packages`
    // Collapse to the placeholder's natural height — the iframe's
    // `minHeight` was sized for the live preview (320–360 px), which leaves
    // an empty white band below a short placeholder. Letting the empty
    // state size itself reads cleanly and matches the rest of the canvas
    // placeholder modules (container, image, loop).
    return (
      <CanvasModulePlaceholder
        className={mcClassName}
        icon={<PackageSolidIcon size={16} color="currentColor" />}
        label={
          missingDependencies.length === 1
            ? `${moduleDefinition.name} needs 1 package`
            : `${moduleDefinition.name} needs ${missingDependencies.length} packages`
        }
        description={packagesLabel}
        actions={
          <Button
            variant="primary"
            size="xs"
            data-testid="module-sandbox-missing-deps-add"
            onClick={() => {
              for (const dep of missingDependencies) {
                setDependency(dep.name, dep.version, dep.dev)
              }
              setDependenciesPanelOpen(true)
            }}
          >
            {buttonLabel}
          </Button>
        }
      />
    )
  }

  // mountKey isolates the inputs that should cause a full iframe remount
  // (new source code, new import map, new node identity). React's `key`
  // remounts the SandboxIframeBody child when these change; otherwise the
  // child stays mounted and routes sandboxContext / classCSS edits through
  // postMessage (no costly module re-execution per prop change).
  const importMapKey = JSON.stringify(importMap)
  const mountKey = `${runtime.source}|${moduleDefinition.name}|${importMapKey}|${sandboxContext.nodeId}`

  return (
    <div
      className={cn(styles.frame, mcClassName)}
      style={{ '--module-sandbox-min-height': `${runtime.minHeight ?? 360}px` } as CSSProperties}
    >
      <SandboxIframeBody
        key={mountKey}
        title={`${moduleDefinition.name} sandbox preview`}
        source={runtime.source}
        importMap={importMap}
        sandboxContext={sandboxContext}
        classCSS={classCSS}
        nodeId={nodeId}
        selectNode={selectNode}
        setFocusedPanel={setFocusedPanel}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SandboxIframeBody — the inner iframe + its postMessage update plumbing.
//
// Architecture: the parent passes `key={mountKey}` so React remounts this
// component (and the iframe) when the iframe needs a fresh document. Inside,
// `srcDoc` is computed exactly once via `useState`'s lazy initializer so the
// HTML embeds the sandboxContext + classCSS values that were live AT MOUNT.
// All subsequent sandboxContext / classCSS edits flow over postMessage —
// the iframe never re-bakes its document while the child is mounted.
//
// This shape lets the React Compiler analyze the whole file without a single
// rule disable, and it removes the "rebuild on subset, snapshot the rest"
// pattern that previously needed an exhaustive-deps escape hatch.
// ---------------------------------------------------------------------------

interface SandboxIframeBodyProps {
  title: string
  source: string
  importMap: ReturnType<typeof createModuleImportMap>
  sandboxContext: SandboxContext
  classCSS: string
  nodeId: string
  selectNode: (id: string) => void
  setFocusedPanel: (panel: FocusedPanel) => void
}

function SandboxIframeBody({
  title,
  source,
  importMap,
  sandboxContext,
  classCSS,
  nodeId,
  selectNode,
  setFocusedPanel,
}: SandboxIframeBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const pendingUpdateRef = useRef<{ context: SandboxContext; classCSS: string } | null>(null)
  const updateFrameRef = useRef<number | null>(null)

  // Bake the srcDoc ONCE at mount. `useState`'s lazy initializer guarantees
  // single-call semantics, so the iframe document embeds the exact snapshot
  // of sandboxContext + classCSS that was live when the parent decided to
  // remount this child (via its key prop).
  const [srcDoc] = useState(() =>
    createSandboxSrcDoc({
      title,
      source,
      importMap,
      context: sandboxContext,
      classCSS,
    }),
  )

  // useCallback kept: transitive dep of scheduleUpdate, which is in a useEffect dep array (exhaustive-deps).
  const flushUpdate = useCallback(() => {
    const payload = pendingUpdateRef.current
    if (!payload) return

    pendingUpdateRef.current = null
    iframeRef.current?.contentWindow?.postMessage({
      source: HOST_MESSAGE_SOURCE,
      type: 'update',
      context: payload.context,
      classCSS: payload.classCSS,
    }, '*')
  }, [])

  // useCallback kept: stable identity for the [scheduleUpdate] useEffect dep array (exhaustive-deps).
  const scheduleUpdate = useCallback(() => {
    pendingUpdateRef.current = { context: sandboxContext, classCSS }
    if (updateFrameRef.current !== null) return

    updateFrameRef.current = window.requestAnimationFrame(() => {
      updateFrameRef.current = null
      flushUpdate()
    })
  }, [sandboxContext, classCSS, flushUpdate])

  const postUpdate = () => {
    pendingUpdateRef.current = { context: sandboxContext, classCSS }
    if (updateFrameRef.current !== null) {
      window.cancelAnimationFrame(updateFrameRef.current)
      updateFrameRef.current = null
    }
    flushUpdate()
  }

  useEffect(() => {
    scheduleUpdate()
  }, [scheduleUpdate])

  useEffect(() => () => {
    if (updateFrameRef.current !== null) {
      window.cancelAnimationFrame(updateFrameRef.current)
      updateFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return

      const message = event.data as { source?: string; type?: string; nodeId?: string } | null
      if (!message || message.source !== SANDBOX_MESSAGE_SOURCE || message.nodeId !== nodeId) return

      if (message.type === 'pointerdown' || message.type === 'dblclick') {
        selectNode(nodeId)
        setFocusedPanel('canvas')
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [nodeId, selectNode, setFocusedPanel])

  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={postUpdate}
      className={styles.iframe}
    />
  )
}
