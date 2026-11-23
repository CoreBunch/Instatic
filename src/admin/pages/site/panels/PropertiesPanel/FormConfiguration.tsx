import { useId, useState, type ReactNode } from 'react'
import { memberFormAction } from '@core/members'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { MailSolidIcon } from 'pixel-art-icons/icons/mail-solid'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import type { FormContextSummary } from './formSettingsAnalysis'
import styles from './FormConfiguration.module.css'

const SECTIONS = [
  { name: 'Destination', icon: DatabaseSolidIcon },
  { name: 'After submission', icon: MailSolidIcon },
  { name: 'Advanced', icon: SlidersHorizontalIcon },
] as const

const MODES = [
  { value: 'cms', label: 'Collect submissions', description: 'Store responses in a CMS table.' },
  { value: 'member', label: 'Member action', description: 'Handle sign-in or account actions.' },
  { value: 'custom', label: 'Custom action', description: 'Send responses to your own endpoint.' },
] as const

const PREVIEWS = [
  { value: 'default', label: 'Default' },
  { value: 'submitting', label: 'Submitting' },
  { value: 'success', label: 'Success' },
  { value: 'error', label: 'Error' },
] as const

type Section = (typeof SECTIONS)[number]['name']
type PreviewState = (typeof PREVIEWS)[number]['value']

interface Props {
  form: FormContextSummary
  tableName?: string
  tableLoading: boolean
  resolvedProps: Record<string, unknown>
  controls: Record<string, ReactNode>
  onModeChange: (mode: FormContextSummary['mode']) => void
  identity: ReactNode
  children: ReactNode
  previewState: PreviewState
  onPreviewStateChange: (state: PreviewState) => void
}

function destinationSummary({ form, tableName, tableLoading, resolvedProps }: Props): string {
  if (form.mode === 'member') return memberFormAction(form.memberAction)?.label ?? 'Member action'
  if (form.mode === 'custom') return String(resolvedProps.action || 'Current page')
  if (tableName) return `CMS · ${tableName}`
  if (!form.targetTableId) return 'Choose a CMS table'
  return tableLoading ? 'Loading table…' : 'Table unavailable'
}

export function FormConfiguration(props: Props) {
  const { form, resolvedProps, controls, previewState, onPreviewStateChange } = props
  const [section, setSection] = useState<Section | null>(null)
  const modeGroup = useId()
  const previewId = useId()
  const custom = form.mode === 'custom'
  const response = custom ? 'Handled by the destination'
    : resolvedProps.successBehavior === 'redirect' ? 'Redirect to a page' : 'Show thank-you message'

  return (
    <>
      <dl className={styles.summary}>
        <div><dt>Destination</dt><dd>{destinationSummary(props)}</dd></div>
        <div><dt>After submission</dt><dd>{response}</dd></div>
      </dl>
      <Button size="sm" variant="secondary" fullWidth onClick={() => setSection('Destination')}>
        <SlidersHorizontalIcon size={14} /> Edit form settings
      </Button>
      <div className={styles.preview}>
        <ControlRow propKey="form-preview-state" inputId={previewId} label="Canvas preview" layout="stacked">
          <Select id={previewId} fieldSize="sm" value={previewState} options={[...PREVIEWS]}
            onChange={(event) => {
              const state = PREVIEWS.find(({ value }) => value === event.target.value)
              if (state) onPreviewStateChange(state.value)
            }}
          />
        </ControlRow>
      </div>
      {section && (
        <Dialog open onClose={() => setSection(null)} size="2xl" ariaLabel="Form settings"
          className={styles.dialog} bodyClassName={styles.dialogBody}
          title={<span className={styles.title}><FileTextSolidIcon size={18} />Form settings <code>{form.formId}</code></span>}
          footer={<Button variant="primary" onClick={() => setSection(null)}>Done</Button>}
        >
          <div className={styles.layout}>
            <nav className={styles.navigation} aria-label="Form settings sections">
              {SECTIONS.map(({ name, icon: Icon }) => (
                <Button key={name} variant={section === name ? 'secondary' : 'ghost'} size="md"
                  align="start" aria-current={section === name ? 'true' : undefined} onClick={() => setSection(name)}>
                  <Icon size={16} />{name}
                </Button>
              ))}
            </nav>
            <section className={styles.content}>
              {section === 'Destination' && (
                <>
                  <h3 id={modeGroup}>What should this form do?</h3>
                  <div role="radiogroup" aria-labelledby={modeGroup}>
                    {MODES.map(({ value, label, description }) => (
                      <div key={value} className={styles.choice}>
                        <label className={styles.choiceLabel}>
                          <Input type="radio" name={modeGroup} value={value} checked={form.mode === value}
                            aria-label={label} aria-describedby={`${modeGroup}-${value}`} onChange={() => props.onModeChange(value)} />
                          <span><strong>{label}</strong><small id={`${modeGroup}-${value}`}>{description}</small></span>
                        </label>
                        {form.mode === value && (
                          <div className={styles.detail}>
                            {props.children}
                            {custom && <>{controls.action}{controls.method}</>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {section === 'After submission' && (
                <>
                  <h3>After submission</h3>
                  {custom ? <p>The destination handles the response to a custom action.</p> : (
                    <>{controls.successBehavior}{controls.successMessage}{controls.redirectUrl}</>
                  )}
                </>
              )}
              {section === 'Advanced' && (
                <>
                  <h3>Advanced</h3>
                  {props.identity}
                  {form.mode === 'cms' && (
                    <><h4>Spam protection</h4>{controls.honeypotName}{controls.minSubmitSeconds}</>
                  )}
                </>
              )}
            </section>
          </div>
        </Dialog>
      )}
    </>
  )
}
