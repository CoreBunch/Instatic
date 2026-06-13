import { useId, useState, type FormEvent } from 'react'
import { styleRuleSelector, type StyleRule } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './SelectorDialogs.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

type SelectorDialogMode = 'auto' | 'class' | 'ambient'

const SELECTOR_NAME_FORM_ID = 'selector-name-form'

function normalizeClassNameInput(value: string) {
  const trimmed = value.trim()
  return (trimmed.startsWith('.') ? trimmed.slice(1) : trimmed).trim()
}

function selectorInputValue(className: string) {
  return className ? `.${className}` : ''
}

function selectorFieldLabel(mode: SelectorDialogMode) {
  if (mode === 'class') return 'Class name'
  if (mode === 'ambient') return 'CSS selector'
  return 'Selector'
}

function selectorPlaceholder(mode: SelectorDialogMode) {
  if (mode === 'class') return '.hero-card'
  if (mode === 'ambient') return 'h1, .hero .title, a:hover'
  return '.hero-card, h1, .hero .title, a:hover'
}

export function SelectorNameDialog({
  title,
  initialValue,
  submitLabel,
  onCancel,
  onSubmit,
  mode = 'auto',
}: {
  title: string
  initialValue: string
  submitLabel: string
  onCancel: () => void
  onSubmit: (value: string) => void
  mode?: SelectorDialogMode
}) {
  const isClassNameMode = mode === 'class'
  const [name, setName] = useState(isClassNameMode ? selectorInputValue(initialValue) : initialValue)
  const [error, setError] = useState<string | null>(null)
  const trimmedValue = isClassNameMode ? normalizeClassNameInput(name) : name.trim()
  const nameInputId = useId()
  const fieldLabel = selectorFieldLabel(mode)
  const fieldPlaceholder = selectorPlaceholder(mode)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedValue) return
    try {
      onSubmit(trimmedValue)
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to save selector').replace(/^\[[^\]]+\]\s*/, ''))
    }
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={SELECTOR_NAME_FORM_ID}
            disabled={!trimmedValue}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={SELECTOR_NAME_FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameInputId} className={dialogStyles.label}>{fieldLabel}</label>
          <Input
            id={nameInputId}
            fieldSize="sm"
            value={name}
            placeholder={fieldPlaceholder}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            aria-label={fieldLabel}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}

export function DeleteSelectorDialog({
  cls,
  usage,
  onCancel,
  onDelete,
}: {
  cls: StyleRule
  usage: string | null
  onCancel: () => void
  onDelete: () => void
}) {
  const selectorLabel = styleRuleSelector(cls)

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Delete selector"
      tone="danger"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" type="button" onClick={onDelete}>
            Delete selector
          </Button>
        </>
      }
    >
      <p className={styles.dialogCopy}>
        Delete <span className={styles.dialogStrong}>{selectorLabel}</span>?
        {usage !== null && ` This selector is ${usage.toLowerCase()}.`}
      </p>
    </Dialog>
  )
}
