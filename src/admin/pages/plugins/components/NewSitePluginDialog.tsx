/**
 * NewSitePluginDialog — name + template picker for `New site plugin`.
 *
 * The kebab-case local id derives live from the name (shown, editable);
 * each template scaffolds a WORKING minimal shape with its permissions
 * pre-declared (declared, not granted — consent happens at activation).
 * On success the caller navigates straight into the Plugin IDE.
 */
import { useState } from 'react'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  SITE_PLUGIN_LOCAL_ID_PATTERN,
  SITE_PLUGIN_TEMPLATES,
  type SitePluginTemplateId,
} from '@core/site-plugins'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import styles from './NewSitePluginDialog.module.css'

const ScaffoldResponseSchema = Type.Object({
  ok: Type.Boolean(),
  localId: Type.String(),
  files: Type.Array(Type.String()),
})

function deriveLocalId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
}

interface NewSitePluginDialogProps {
  existingLocalIds: string[]
  onClose: () => void
  onCreated: (localId: string) => void
}

export function NewSitePluginDialog({
  existingLocalIds,
  onClose,
  onCreated,
}: NewSitePluginDialogProps) {
  const [name, setName] = useState('')
  const [localIdTouched, setLocalIdTouched] = useState(false)
  const [localId, setLocalId] = useState('')
  const [template, setTemplate] = useState<SitePluginTemplateId>('module')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveLocalId = localIdTouched ? localId : deriveLocalId(name)
  const idValid = SITE_PLUGIN_LOCAL_ID_PATTERN.test(effectiveLocalId)
  const idTaken = existingLocalIds.includes(effectiveLocalId)
  const canSubmit = name.trim().length > 0 && idValid && !idTaken && !busy

  // Field-local validation stays inline (allowed exception); operation
  // failures surface via the dialog-level alert below.
  const idHint = !effectiveLocalId
    ? null
    : !idValid
      ? 'Id must be lowercase kebab-case and start with a letter.'
      : idTaken
        ? 'A site plugin with this id already exists.'
        : null

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await apiRequest('/admin/api/cms/site-plugins', {
        method: 'POST',
        body: { name: name.trim(), localId: effectiveLocalId, template },
        schema: ScaffoldResponseSchema,
      })
      onCreated(result.localId)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create the site plugin'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      eyebrow="Site plugins"
      title="New site plugin"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="create-site-plugin"
          >
            {busy ? 'Creating…' : 'Create & open IDE'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <label className={styles.label} htmlFor="site-plugin-name">
          Name
        </label>
        <Input
          id="site-plugin-name"
          value={name}
          placeholder="Newsletter"
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />

        <label className={styles.label} htmlFor="site-plugin-id">
          Plugin id
        </label>
        <Input
          id="site-plugin-id"
          value={effectiveLocalId}
          prefix="site."
          monospace
          invalid={Boolean(idHint)}
          onChange={(event) => {
            setLocalIdTouched(true)
            setLocalId(event.currentTarget.value)
          }}
        />
        {idHint && (
          <p className={styles.fieldError} role="alert">
            {idHint}
          </p>
        )}

        <span className={styles.label}>Template</span>
        <div className={styles.templates} role="radiogroup" aria-label="Scaffold template">
          {SITE_PLUGIN_TEMPLATES.map((option) => (
            <Button
              key={option.id}
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={template === option.id}
              pressed={template === option.id}
              className={styles.templateCard}
              onClick={() => setTemplate(option.id)}
              data-testid={`template-${option.id}`}
            >
              <span className={styles.templateLabel}>{option.label}</span>
              <span className={styles.templateDescription}>{option.description}</span>
            </Button>
          ))}
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
