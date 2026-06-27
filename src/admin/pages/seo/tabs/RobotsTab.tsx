/**
 * RobotsTab — robots.txt as a directly-edited document.
 *
 * The body IS the artifact: it lives in an editable CodeMirror surface (the
 * main column) and saves to `site.settings.seo.robots.content`. The left
 * rail is an assistant, not a parallel form — it explains the file, surfaces
 * contextual recommendations + lint, and offers one-click inserts that edit
 * the document (block AI crawlers, block system paths, reset, …). The server
 * appends the `Sitemap:` line and enforces preview-host protection; the
 * author never hand-manages the production origin.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import { getErrorMessage } from '@core/utils/errorMessage'
import { publishCmsDraft } from '@core/persistence'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  lintRobotsTxt,
  matchRobots,
  generateRobotsTxt,
  AI_TRAINING_CRAWLERS,
  AI_ANSWER_CRAWLERS,
  SYSTEM_DISALLOW_PATHS,
  DEFAULT_ROBOTS_TEMPLATE,
  type SeoRobotsSettings,
} from '@core/seo'
import { SeoCodeEditor } from '../components/SeoCodeEditor'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import type { SeoSaveBridge } from '../hooks/useSeoSaveBridge'
import { useSeoSaveSurface } from '../hooks/useSeoSaveBridge'
import styles from './SettingsTabs.module.css'

interface RobotsTabProps {
  workspace: SeoWorkspace
  canManage: boolean
  bridge: SeoSaveBridge
}

type SaveState = 'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\*]/g, '\\$&')
}

/** Append `User-agent: <bot>\nDisallow: /` blocks for bots not already present. */
function appendBotBlocks(text: string, bots: readonly string[]): string {
  const missing = bots.filter(
    (bot) => !new RegExp(`^user-agent:\\s*${escapeRegExp(bot)}\\s*$`, 'im').test(text),
  )
  if (missing.length === 0) return text
  const block = missing.map((bot) => `User-agent: ${bot}\nDisallow: /`).join('\n\n')
  return text.trim() === '' ? block : `${text.trimEnd()}\n\n${block}`
}

/** Add `Disallow:` lines into the `User-agent: *` group (creating it if absent). */
function addStarDisallows(text: string, paths: readonly string[]): string {
  const additions = paths.map((path) => `Disallow: ${path}`)
  const lines = text.split('\n')
  const missing = additions.filter(
    (line) => !lines.some((existing) => existing.trim().toLowerCase() === line.toLowerCase()),
  )
  if (missing.length === 0) return text
  const starIndex = lines.findIndex((line) => /^user-agent:\s*\*\s*$/i.test(line.trim()))
  if (starIndex === -1) {
    const block = ['User-agent: *', ...missing].join('\n')
    return text.trim() === '' ? block : `${text.trimEnd()}\n\n${block}`
  }
  lines.splice(starIndex + 1, 0, ...missing)
  return lines.join('\n')
}

export function RobotsTab({ workspace, canManage, bridge }: RobotsTabProps) {
  const stored = workspace.siteSeo?.robots ?? {}
  const baseline = stored.content ?? DEFAULT_ROBOTS_TEMPLATE

  const [content, setContent] = useState<string>(baseline)
  // Bumped only on programmatic edits (shortcuts) to remount CM6 with the new
  // text; plain typing flows through onChange without a remount.
  const [editorRev, setEditorRev] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const currentUser = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const canPublish = !currentUser || hasCapability(currentUser, 'pages.publish')

  const isDirty = content !== baseline
  const lint = lintRobotsTxt(content)

  // Contextual recommendations — each is also the shortcut that resolves it.
  const allBlocked = !matchRobots(content, 'Googlebot', '/').allowed
  const adminExposed = matchRobots(content, 'Googlebot', '/admin').allowed
  const trainingOpen = AI_TRAINING_CRAWLERS.some((bot) => matchRobots(content, bot, '/').allowed)
  const answerOpen = AI_ANSWER_CRAWLERS.some((bot) => matchRobots(content, bot, '/').allowed)

  function touch(): void {
    if (saveState !== 'idle') setSaveState('idle')
  }

  /** Plain typing from the editor — no remount. */
  function handleEdit(next: string): void {
    setContent(next)
    touch()
  }

  /** Programmatic edit from a shortcut — remount CM6 to show the new text. */
  function applyEdit(transform: (prev: string) => string): void {
    setContent((prev) => transform(prev))
    setEditorRev((rev) => rev + 1)
    touch()
  }

  async function handleSave(): Promise<boolean> {
    setSaveState('saving')
    setSaveError(null)
    try {
      const robots: SeoRobotsSettings = content.trim() === '' ? {} : { content }
      await workspace.saveSite({ ...(workspace.siteSeo ?? {}), robots })
      setSaveState('saved')
      return true
    } catch (err) {
      console.error('[seo-page] robots save failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not save robots settings'))
      return false
    }
  }

  async function handlePublish(): Promise<void> {
    if (isDirty && !(await handleSave())) return
    setSaveState('publishing')
    try {
      // Full site publish — step-up gated, same as the Site toolbar.
      await runStepUp(() => publishCmsDraft())
      setSaveState('published')
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setSaveState('saved')
        return
      }
      console.error('[seo-page] publish failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not publish'))
    }
  }

  useSeoSaveSurface(
    bridge,
    {
      dirty: isDirty,
      state: saveState,
      canSave: canManage,
      canPublish,
      publishScope: 'site',
      liveUrl: workspace.publicOrigin ? `${workspace.publicOrigin}/robots.txt` : null,
    },
    { save: () => void handleSave(), publish: () => void handlePublish() },
  )

  const recommendations: { id: string; warn?: boolean; label: string; text: string; onApply: () => void }[] = []
  if (allBlocked) {
    recommendations.push({
      id: 'all-blocked',
      warn: true,
      label: 'Allow crawlers',
      text: 'every crawler is blocked, so the site won’t appear in search.',
      onApply: () => applyEdit(() => 'User-agent: *\nAllow: /'),
    })
  } else {
    if (adminExposed) {
      recommendations.push({
        id: 'admin',
        label: 'Block system paths',
        text: 'admin and internal routes are crawlable.',
        onApply: () => applyEdit((prev) => addStarDisallows(prev, SYSTEM_DISALLOW_PATHS)),
      })
    }
    if (trainingOpen) {
      recommendations.push({
        id: 'ai-training',
        label: 'Block AI training crawlers',
        text: 'they can ingest your content for model training.',
        onApply: () => applyEdit((prev) => appendBotBlocks(prev, AI_TRAINING_CRAWLERS)),
      })
    }
    if (answerOpen) {
      recommendations.push({
        id: 'ai-answer',
        label: 'Block AI answer crawlers',
        text: 'they fetch your pages to ground live AI answers.',
        onApply: () => applyEdit((prev) => appendBotBlocks(prev, AI_ANSWER_CRAWLERS)),
      })
    }
  }

  return (
    <section className={styles.tab} aria-label="Robots.txt settings">
      <div className={styles.editorWorkbench}>
        <aside className={styles.assistColumn} aria-label="robots.txt help">
          <div className={styles.card}>
            <header className={styles.cardHeader}>
              <h2 className={styles.heading}>Robots.txt</h2>
              <p className={styles.subheading}>
                Served at <code>/robots.txt</code>, live on publish. The <code>Sitemap:</code> line
                is added automatically.
              </p>
            </header>

            {recommendations.length > 0 && (
              <div className={styles.assistGroup}>
                <h3 className={styles.assistLabel}>Recommendations</h3>
                <div className={styles.adviceList}>
                  {recommendations.map((rec) => (
                    <button
                      key={rec.id}
                      type="button"
                      className={styles.adviceRow}
                      disabled={!canManage}
                      onClick={rec.onApply}
                      data-testid={`seo-robots-rec-${rec.id}`}
                    >
                      <span className={cn(styles.adviceDot, rec.warn && styles.adviceDotWarn)} aria-hidden="true" />
                      <span className={styles.adviceText}><strong>{rec.label}</strong> — {rec.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.assistGroup}>
              <h3 className={styles.assistLabel}>Insert</h3>
              <div className={styles.shortcutRow}>
                <Button variant="secondary" size="xs" disabled={!canManage}
                  onClick={() => applyEdit(() => DEFAULT_ROBOTS_TEMPLATE)} data-testid="seo-robots-reset">
                  Defaults
                </Button>
                <Button variant="secondary" size="xs" disabled={!canManage}
                  onClick={() => applyEdit((prev) => appendBotBlocks(prev, [...AI_TRAINING_CRAWLERS, ...AI_ANSWER_CRAWLERS]))}
                  data-testid="seo-robots-block-ai">
                  Block AI crawlers
                </Button>
                <Button variant="secondary" size="xs" disabled={!canManage}
                  onClick={() => applyEdit(() => 'User-agent: *\nDisallow: /')} data-testid="seo-robots-block-all">
                  Block everything
                </Button>
              </div>
            </div>

            {lint.length > 0 && (
              <div className={styles.assistGroup}>
                <h3 className={styles.assistLabel}>Issues</h3>
                <div className={styles.adviceList} aria-label="robots.txt issues">
                  {lint.map((finding, i) => (
                    <div key={i} className={styles.adviceRow}>
                      <span
                        className={cn(styles.adviceDot, finding.level === 'error' ? styles.adviceDotDanger : styles.adviceDotWarn)}
                        aria-hidden="true"
                      />
                      <span className={styles.adviceText}><strong>Line {finding.line}</strong> — {finding.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.assistGroup}>
              <h3 className={styles.assistLabel}>Test a URL</h3>
              <RobotsUrlTester
                robotsText={generateRobotsTxt({
                  robots: { content },
                  sitemapEnabled: workspace.siteSeo?.sitemap?.enabled !== false,
                  origin: workspace.publicOrigin ?? undefined,
                })}
              />
            </div>
          </div>
        </aside>

        <div className={styles.editorMain}>
          {saveError && <p className={styles.error} role="alert">{saveError}</p>}
          <SeoCodeEditor
            docKey={`robots:${editorRev}`}
            value={content}
            language="text"
            disabled={!canManage}
            ariaLabel="robots.txt content"
            onChange={handleEdit}
            data-testid="seo-robots-editor"
          />
          {workspace.publicOrigin && (
            <p className={styles.servedNote} role="status">
              Served at <code>{workspace.publicOrigin}/robots.txt</code>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** Live "is this URL crawlable?" checker against the served file. */
function RobotsUrlTester({ robotsText }: { robotsText: string }) {
  const [userAgent, setUserAgent] = useState('Googlebot')
  const [path, setPath] = useState('/')
  const result = matchRobots(robotsText, userAgent.trim() || '*', path.trim() || '/')

  return (
    <div className={styles.tester}>
      <div className={styles.testerRow}>
        <Input
          type="text"
          value={userAgent}
          placeholder="User-agent"
          aria-label="Test user-agent"
          onChange={(e) => setUserAgent(e.target.value)}
          data-testid="seo-robots-test-ua"
        />
        <Input
          type="text"
          value={path}
          placeholder="/path/to/page"
          aria-label="Test path"
          onChange={(e) => setPath(e.target.value)}
          data-testid="seo-robots-test-path"
        />
      </div>
      <p className={styles.testerResult} role="status" data-testid="seo-robots-test-result">
        <span
          className={cn(styles.adviceDot, result.allowed ? styles.adviceDotOk : styles.adviceDotDanger)}
          aria-hidden="true"
        />
        <span className={styles.adviceText}>
          <strong>{result.allowed ? 'Allowed' : 'Blocked'}</strong>
          {result.rule ? ` · matched ${result.rule}` : ' · no matching rule'}
        </span>
      </p>
    </div>
  )
}
