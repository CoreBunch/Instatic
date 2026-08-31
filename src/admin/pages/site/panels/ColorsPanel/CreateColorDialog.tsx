import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { CategoryComboBox } from './CategoryComboBox'
import { ColorValueField } from './ColorValueField'
import { DEFAULT_NEW_TOKEN_COLOR } from './helpers'
import dialogStyles from '../../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'

interface CreateColorDialogProps {
  categories: string[]
  defaultCategory: string
  onCancel: () => void
  onSubmit: (name: string, lightValue: string, category: string) => void
}

const FORM_ID = 'create-color-form'

export function CreateColorDialog({
  categories,
  defaultCategory,
  onCancel,
  onSubmit,
}: CreateColorDialogProps) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(defaultCategory)
  const [lightValue, setLightValue] = useState(DEFAULT_NEW_TOKEN_COLOR)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameInputId = useId()
  const canSubmit = Boolean(name.trim() && lightValue.trim())

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit(name, lightValue, category.trim())
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Create color"
      size="sm"
      initialFocusRef={nameInputRef}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!canSubmit}
          >
            Create
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameInputId} className={dialogStyles.label}>Token name</label>
          <Input
            id={nameInputId}
            ref={nameInputRef}
            fieldSize="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Token name"
            autoComplete="off"
            spellCheck={false}
            prefix="--"
          />
        </div>
        <CategoryComboBox
          label="Category"
          suggestions={categories}
          value={category}
          onValueChange={setCategory}
          onCommit={(next) => setCategory(next.trim())}
          fieldClassName={dialogStyles.field}
          labelClassName={dialogStyles.label}
        />
        <ColorValueField
          label="Default color"
          inputLabel="Default color"
          swatchLabel="Default color swatch"
          value={lightValue}
          onValueChange={setLightValue}
          onCommit={setLightValue}
          fieldClassName={dialogStyles.field}
          labelClassName={dialogStyles.label}
        />
      </form>
    </Dialog>
  )
}
