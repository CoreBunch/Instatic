/**
 * Templates: the wording of each email the site sends. A template is a
 * subject and a body written in the same editor as posts, with `{variables}`
 * filled in at send time. The preview beside it is rendered by the same code
 * the server sends with, using sample values.
 */
import { useId, useRef, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { TiptapBodyEditor, type TiptapBodyEditorHandle } from '@admin/pages/content/TiptapBodyEditor'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SettingsListSection } from '@admin/shared/SettingsWorkspace/SettingsListSection'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
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

export function TemplatesTab() {
  const { data, loading, error, refresh } = useAsyncResource(
    (signal) => listCmsMailTemplates(signal),
    [],
    { fallbackError: 'Could not load the email templates.' },
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
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
                      <span className={ws.settingsListMeta}>{template.customised ? 'Edited' : 'Built-in wording'}</span>
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
  const [lastFocus, setLastFocus] = useState<'subject' | 'body'>('body')
  const [variablePickerOpen, setVariablePickerOpen] = useState(false)
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null)
  const [testTo, setTestTo] = useState(user?.email ?? '')

  const dirty = subject !== template.subject || body !== template.body
  const unknown = unknownMailVariables(`${subject}\n${body}`, template.variables)
  const saveProblem = !subject.trim()
    ? 'Write a subject.'
    : !body.trim() ? 'Write a body.' : dirty ? null : 'No changes to save.'
  const testProblem = dirty
    ? 'Save your changes first.'
    : ADDRESS_RE.test(testTo.trim()) ? null : 'Enter the address to send the test to.'

  const preview = renderMailTemplate({ subject, body }, sampleMailVariables(template.variables))

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
    setVariablePickerOpen(false)
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
              <span className={ws.connectionStatus}>
                <span className={ws.healthDot} />
                {template.customised ? 'Edited' : 'Built-in wording'}
              </span>
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

      <div className={styles.templateGrid}>
        <div className={styles.templateEdit}>
          <div className={styles.field}>
            <label htmlFor={subjectId}>Subject</label>
            <Input
              ref={subjectRef}
              id={subjectId}
              value={subject}
              onChange={(event) => setSubject(event.currentTarget.value)}
              onFocus={() => setLastFocus('subject')}
              maxLength={200}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Variables</span>
            <div className={styles.variables}>
              {template.variables.map((variable) => (
                <Button
                  key={variable.name}
                  type="button"
                  variant="secondary"
                  size="xs"
                  shape="pill"
                  onClick={() => insertVariable(variable.name)}
                  tooltip={`${variable.label}. Inserts into the ${lastFocus}.`}
                >
                  {`{${variable.name}}`}
                </Button>
              ))}
            </div>
            {unknown.length > 0 && (
              <p className={styles.warning} role="status">
                {unknown.map((name) => `{${name}}`).join(', ')} {unknown.length === 1 ? 'is not a variable' : 'are not variables'} of
                this email and will be sent as written.
              </p>
            )}
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Body</span>
            <div className={styles.editorShell} onFocusCapture={() => setLastFocus('body')}>
              <TiptapBodyEditor
                markdown={template.body}
                editorRef={editorRef}
                onChange={setBody}
                onInsertDataToken={() => setVariablePickerOpen(true)}
                ariaLabel="Email body"
              />
            </div>
          </div>
        </div>

        <div className={styles.templatePreview} aria-label="Preview">
          <span className={styles.fieldLabel}>Preview, with sample values</span>
          <div className={styles.previewFrame}>
            <p className={styles.previewSubject}>{preview.subject}</p>
            <iframe className={styles.previewBody} title="Email preview" sandbox="" srcDoc={preview.html} />
          </div>
        </div>
      </div>

      <section className={ws.detailSection}>
        <div className={ws.detailSectionHeader}>
          <div>
            <h3>Send a test email</h3>
            <p>Sends this template with the sample values. Links in it do not work.</p>
          </div>
        </div>
        <form className={ws.providerSetupForm} onSubmit={(event) => { event.preventDefault(); void handleTest() }}>
          <div className={ws.providerSetupField}>
            <label htmlFor={testId}>Send to</label>
            <div>
              <Input id={testId} type="email" value={testTo} onChange={(event) => setTestTo(event.currentTarget.value)} placeholder="you@example.com" />
              {testProblem && <p>{testProblem}</p>}
            </div>
          </div>
          <div className={ws.providerSetupActions}>
            <Button type="submit" variant="secondary" size="md" disabled={testProblem !== null || busy !== null} busy={busy === 'test'}>
              Send test email
            </Button>
          </div>
        </form>
      </section>

      {variablePickerOpen && (
        <Dialog open onClose={() => setVariablePickerOpen(false)} title="Insert a variable" size="sm">
          <div className={styles.variableList}>
            {template.variables.map((variable) => (
              <Button
                key={variable.name}
                type="button"
                variant="ghost"
                size="md"
                align="between"
                fullWidth
                onClick={() => insertVariable(variable.name)}
              >
                <span>{variable.label}</span>
                <code>{`{${variable.name}}`}</code>
              </Button>
            ))}
          </div>
        </Dialog>
      )}
    </article>
  )
}
