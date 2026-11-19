/**
 * Templates: the wording of each email the site sends. A template is a
 * subject and a body, with `{variables}` filled in at send time.
 *
 * It is edited the way a post is: the same TipTap editor, with the same
 * Write / Live switch in the top-left corner. Live edits the email in place
 * inside the layout it is sent in; Write is the bare writing surface. "Send
 * test" shows the email with sample values, rendered by the same code the
 * server sends with.
 */
import { useId, useRef, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { ContentModeToggle } from '@admin/pages/content/components/ContentModeToggle/ContentModeToggle'
import { TiptapBodyEditor, type TiptapBodyEditorHandle } from '@admin/pages/content/TiptapBodyEditor'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SettingsListSection } from '@admin/shared/SettingsWorkspace/SettingsListSection'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import {
  MAIL_ADDRESS_PATTERN,
  renderMailTemplate,
  sampleMailVariables,
  unknownMailVariables,
  type MailTemplate,
} from '@core/mail'
import {
  listCmsMailTemplates,
  resetCmsMailTemplate,
  saveCmsMailTemplate,
  testCmsMailTemplate,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import styles from '../EmailPage.module.css'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

function isCancelledStepUp(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

export function TemplatesTab({ initialKey }: { initialKey: string | null }) {
  const { data, loading, error, refresh } = useAsyncResource(
    (signal) => listCmsMailTemplates(signal),
    [],
    { fallbackError: 'Could not load the email templates.' },
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey)
  // A save or reset returns the fresh template; keep it so the list and the
  // editor agree without waiting for a reload.
  const [updated, setUpdated] = useState<Record<string, MailTemplate>>({})

  const templates = (data ?? []).map((template) => updated[template.key] ?? template)
  const selected = templates.find((template) => template.key === selectedKey) ?? templates[0]
  const groups = [...new Set(templates.map((template) => template.group))]

  return (
    <section className={ws.settingsWorkspace} aria-labelledby="templates-heading">
      <aside className={ws.settingsBrowser} aria-label="Template browser">
        <div className={ws.settingsBrowserHeader}>
          <h2 id="templates-heading">Templates</h2>
        </div>
        {error && <p role="alert" className={ws.settingsBrowserError}>{error}</p>}
        {loading && templates.length === 0 && <p className={ws.settingsBrowserEmpty}>Loading templates…</p>}

        <div className={ws.settingsBrowserSections}>
          {groups.map((group) => (
            <SettingsListSection key={group} label={group}>
              {templates.filter((template) => template.group === group).map((template) => {
                const active = selected?.key === template.key
                return (
                  <Button
                    key={template.key}
                    type="button"
                    variant="ghost"
                    size="md"
                    fullWidth
                    active={active}
                    align="start"
                    className={ws.settingsListItem}
                    onClick={() => setSelectedKey(template.key)}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className={ws.providerMark} data-size="sm" aria-hidden="true">
                      <FileTextSolidIcon size={14} />
                    </span>
                    <span className={ws.settingsListIdentity}>
                      <span className={ws.settingsListLabel}>{template.label}</span>
                      {template.customised && (
                        <span className={ws.settingsListMeta}>{template.wordingProblem ? 'Not used' : 'Edited'}</span>
                      )}
                    </span>
                    {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                  </Button>
                )
              })}
            </SettingsListSection>
          ))}
        </div>
      </aside>

      <div className={ws.settingsDetailCanvas}>
        {selected && (
          <TemplateEditor
            key={`${selected.key}:${selected.customised}:${selected.subject.length}:${selected.body.length}`}
            template={selected}
            onSaved={(template) => {
              setUpdated((current) => ({ ...current, [template.key]: template }))
              refresh()
            }}
          />
        )}
      </div>
    </section>
  )
}

type Mode = 'write' | 'live'

function TemplateEditor({
  template,
  onSaved,
}: {
  template: MailTemplate
  onSaved: (template: MailTemplate) => void
}) {
  const user = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const subjectId = useId()
  const testId = useId()
  const editorRef = useRef<TiptapBodyEditorHandle>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const [subject, setSubject] = useState(template.subject)
  const [body, setBody] = useState(template.body)
  // The editor is remounted when the mode changes; `mounted.markdown` is the
  // body it starts from, so nothing typed in one mode is lost in the other.
  const [mounted, setMounted] = useState<{ mode: Mode; markdown: string }>({ mode: 'live', markdown: template.body })
  const [lastFocus, setLastFocus] = useState<'subject' | 'body'>('body')
  const [variableMenu, setVariableMenu] = useState<DOMRect | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null)
  const [testTo, setTestTo] = useState(user?.email ?? '')

  const mode = mounted.mode
  const dirty = subject !== template.subject || body !== template.body
  const samples = sampleMailVariables(template.variables)
  const unknown = unknownMailVariables(`${subject}\n${body}`, template.variables)
  const preview = renderMailTemplate({ key: template.key, subject, body, variables: template.variables }, samples)
  const refusedNames = preview.refused.map((name) => `{${name}}`).join(', ')
  const saveProblem = !subject.trim()
    ? 'Write a subject.'
    : !body.trim()
      ? 'Write a body.'
      : unknown.length > 0
        ? `${unknown.map((name) => `{${name}}`).join(', ')} is not a variable of this email.`
        : preview.refused.length > 0
          ? `${refusedNames} must stand alone before this can be saved.`
        : dirty ? null : 'No changes to save.'

  function insertVariable(name: string) {
    const token = `{${name}}`
    if (lastFocus === 'subject') {
      const input = subjectRef.current
      const at = input?.selectionStart ?? subject.length
      setSubject(`${subject.slice(0, at)}${token}${subject.slice(input?.selectionEnd ?? at)}`)
      input?.focus()
    } else {
      editorRef.current?.insertText(token)
    }
    setVariableMenu(null)
  }

  async function handleSave() {
    setBusy('save')
    try {
      onSaved(await runStepUp(() => saveCmsMailTemplate(template.key, { subject: subject.trim(), body })))
      pushToast({ kind: 'success', title: `${template.label} saved` })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[TemplatesTab] save failed:', err)
      pushToast({ kind: 'error', title: 'Could not save the template', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
    }
  }

  async function handleReset() {
    setBusy('reset')
    try {
      onSaved(await runStepUp(() => resetCmsMailTemplate(template.key)))
      pushToast({ kind: 'success', title: `${template.label} is back to the built-in wording` })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[TemplatesTab] reset failed:', err)
      pushToast({ kind: 'error', title: 'Could not reset the template', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
    }
  }

  async function handleTest() {
    setBusy('test')
    try {
      const status = await testCmsMailTemplate(template.key, testTo.trim())
      setTestOpen(false)
      pushToast(
        status === 'captured'
          ? { kind: 'success', title: 'Test email captured', body: 'Nothing was sent. Read it under Activity.' }
          : { kind: 'success', title: 'Test email sent', body: `Check the inbox of ${testTo.trim()}.` },
      )
    } catch (err) {
      console.error('[TemplatesTab] test send failed:', err)
      pushToast({ kind: 'error', title: 'The test email was not sent', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
    }
  }

  const subjectField = (
    <input
      ref={subjectRef}
      id={subjectId}
      className={styles.subjectInput}
      value={subject}
      onChange={(event) => setSubject(event.currentTarget.value)}
      onFocus={() => setLastFocus('subject')}
      maxLength={200}
      placeholder="Subject"
      aria-label="Subject"
    />
  )
  const bodyEditor = (
    <div onFocusCapture={() => setLastFocus('body')}>
      <TiptapBodyEditor
        key={mode}
        markdown={mounted.markdown}
        editorRef={editorRef}
        onChange={setBody}
        onInsertDataToken={() => setVariableMenu(subjectRef.current?.getBoundingClientRect() ?? null)}
        ariaLabel="Email body"
      />
    </div>
  )

  return (
    <article className={ws.credentialDetail} aria-labelledby="template-detail-title">
      <header className={ws.credentialDetailHeader}>
        <div className={ws.credentialDetailIdentity}>
          <span className={ws.providerMark} data-size="lg" aria-hidden="true">
            <FileTextSolidIcon size={22} />
          </span>
          <div>
            <div className={ws.credentialTitleRow}>
              <h2 id="template-detail-title">{template.label}</h2>
            </div>
            <p>{template.description}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {template.customised && (
            <Button type="button" variant="ghost" size="md" onClick={() => void handleReset()} disabled={busy !== null} busy={busy === 'reset'}>
              Reset to built-in
            </Button>
          )}
          <Button type="button" variant="secondary" size="md" onClick={() => setTestOpen(true)} disabled={busy !== null}>
            <SendSolidIcon size={14} aria-hidden="true" />
            <span>Send test</span>
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={() => void handleSave()}
            disabled={saveProblem !== null || busy !== null}
            busy={busy === 'save'}
            tooltip={saveProblem ?? undefined}
          >
            Save template
          </Button>
        </div>
      </header>

      <div className={styles.canvas} data-mode={mode}>
        <ContentModeToggle
          mode={mode}
          onChange={(next) => setMounted({ mode: next, markdown: body })}
        />
        <div className={styles.canvasTools}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => setVariableMenu(event.currentTarget.getBoundingClientRect())}
            tooltip={`Inserts into the ${lastFocus}`}
          >
            <BracesIcon size={13} aria-hidden="true" />
            <span>Insert variable</span>
          </Button>
        </div>

        {mode === 'live' ? (
          <div className={styles.emailStage}>
            <div className={styles.emailCard}>
              <div className={styles.emailSubjectRow}>{subjectField}</div>
              {bodyEditor}
            </div>
            <p className={styles.emailFooter}>{samples['site.name']}</p>
          </div>
        ) : (
          <div className={styles.writeStage}>
            {subjectField}
            {bodyEditor}
          </div>
        )}
      </div>

      {template.wordingProblem !== null && !dirty && (
        <p className={styles.warning} role="alert">
          Your wording is not used: {template.wordingProblem} Until you change it, this email is sent with the built-in
          wording.
        </p>
      )}
      {unknown.length > 0 && (
        <p className={styles.warning} role="status">
          {unknown.map((name) => `{${name}}`).join(', ')} {unknown.length === 1 ? 'is not a variable' : 'are not variables'} of
          this email. Remove {unknown.length === 1 ? 'it' : 'them'}, or write <code>{'\\{'}</code> to keep the braces.
        </p>
      )}
      {preview.refused.length > 0 && (
        <p className={styles.warning} role="status">
          {refusedNames} must stand alone: put a space or a line break around{' '}
          {preview.refused.length === 1 ? 'it' : 'each'}, or use it as the address of a link, so the value cannot
          become part of another address.
        </p>
      )}

      {variableMenu && (
        <ContextMenu
          x={variableMenu.left}
          y={variableMenu.bottom + 6}
          width={300}
          minWidth={300}
          ariaLabel="Insert a variable"
          onClose={() => setVariableMenu(null)}
        >
          {template.variables.map((variable) => (
            <ContextMenuItem key={variable.name} onClick={() => insertVariable(variable.name)}>
              <span className={styles.variableLabel}>{variable.label}</span>
              <code className={styles.variableToken}>{`{${variable.name}}`}</code>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}

      {testOpen && (
        <Dialog
          open
          onClose={() => setTestOpen(false)}
          title="Send a test email"
          size="lg"
          footer={(
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => setTestOpen(false)} disabled={busy === 'test'}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleTest()}
                disabled={dirty || !ADDRESS_RE.test(testTo.trim())}
                busy={busy === 'test'}
              >
                Send test
              </Button>
            </>
          )}
        >
          <div className={styles.testDialog}>
            <div className={styles.field}>
              <label htmlFor={testId}>Send to</label>
              <Input id={testId} type="email" value={testTo} onChange={(event) => setTestTo(event.currentTarget.value)} placeholder="you@example.com" />
              <p className={styles.hint}>
                {dirty
                  ? 'Save the template first: a test sends the saved version.'
                  : 'Sent as shown below. Links use sample values, so they do not work.'}
              </p>
            </div>
            <div className={styles.previewFrame}>
              <p className={styles.previewSubject}>{preview.subject}</p>
              <iframe className={styles.previewBody} title="Email preview" sandbox="" srcDoc={preview.html} />
            </div>
          </div>
        </Dialog>
      )}
    </article>
  )
}
