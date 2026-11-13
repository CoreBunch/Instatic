/**
 * Conditional visibility — show this node only when its data says so.
 *
 * The node stays on the canvas whatever the condition says: this is the
 * surface it gets edited on, and one hidden because the preview row happens to
 * have no video is one the author cannot click. The publisher is where it
 * actually disappears, so the summary line below states the rule in words —
 * that sentence is the only feedback the editor can honestly give.
 */

import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { useEditorStore } from '@site/store/store'
import type { VisibilityCondition } from '@core/page-tree'
import styles from './VisibilityConditionPanel.module.css'

const SOURCE_OPTIONS = [
  { value: 'currentEntry', label: 'This row' },
  { value: 'parentEntry', label: 'The row around it' },
  { value: 'page', label: 'This page' },
  { value: 'site', label: 'The site' },
  { value: 'route', label: 'The URL' },
]

const TEST_OPTIONS = [
  { value: 'isSet', label: 'is filled in' },
  { value: 'isNotSet', label: 'is empty' },
]

const DEFAULT_CONDITION: VisibilityCondition = {
  source: 'currentEntry',
  field: '',
  test: 'isSet',
}

interface VisibilityConditionPanelProps {
  nodeId: string
  visibleWhen: VisibilityCondition | undefined
  readOnly: boolean
}

export function VisibilityConditionPanel({
  nodeId,
  visibleWhen,
  readOnly,
}: VisibilityConditionPanelProps) {
  const setNodeVisibleWhen = useEditorStore((s) => s.setNodeVisibleWhen)
  const condition = visibleWhen ?? null

  function patch(next: Partial<VisibilityCondition>): void {
    const merged = { ...(condition ?? DEFAULT_CONDITION), ...next } as VisibilityCondition
    // An empty field name is a half-typed rule, not a rule. Storing it would
    // hide the node against a field called "", which is never what was meant.
    setNodeVisibleWhen(nodeId, merged.field.trim() ? merged : undefined)
  }

  if (!condition) {
    return (
      <div className={styles.panel}>
        <p className={styles.hint}>
          Always visible. Add a condition to show this only on the rows where a
          field is filled in — a video player on the rows that have a video, a
          caption on the rows that do not.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={readOnly}
          onClick={() => setNodeVisibleWhen(nodeId, { ...DEFAULT_CONDITION, field: 'title' })}
        >
          Add a condition
        </Button>
      </div>
    )
  }

  const sourceLabel = SOURCE_OPTIONS.find((o) => o.value === condition.source)?.label ?? condition.source
  const testLabel = TEST_OPTIONS.find((o) => o.value === condition.test)?.label ?? condition.test

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <Select
          id="visibility-source"
          name="visibility-source"
          fieldSize="sm"
          value={condition.source}
          options={SOURCE_OPTIONS}
          disabled={readOnly}
          onChange={(e) => patch({ source: e.target.value as VisibilityCondition['source'] })}
        />
        <Input
          value={condition.field}
          placeholder="field name"
          disabled={readOnly}
          onChange={(e) => patch({ field: e.target.value })}
        />
        <Select
          id="visibility-test"
          name="visibility-test"
          fieldSize="sm"
          value={condition.test}
          options={TEST_OPTIONS}
          disabled={readOnly}
          onChange={(e) => patch({ test: e.target.value as VisibilityCondition['test'] })}
        />
      </div>
      <p className={styles.summary}>
        Shown when <strong>{sourceLabel}</strong>&rsquo;s{' '}
        <strong>{condition.field || '…'}</strong> {testLabel}. It stays on the
        canvas either way so you can keep editing it.
      </p>
      <Button
        variant="ghost"
        size="sm"
        disabled={readOnly}
        onClick={() => setNodeVisibleWhen(nodeId, undefined)}
      >
        Always show
      </Button>
    </div>
  )
}
