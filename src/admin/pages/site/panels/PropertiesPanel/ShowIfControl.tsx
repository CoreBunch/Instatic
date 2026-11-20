/**
 * ShowIfControl: render an element only when a query parameter of the page
 * address, or a field of the loop item (or entry), passes a test.
 *
 * The condition lives on the node as the `showIf` prop and is applied on the
 * server (`@core/templates` → `showIfAllows`). It sits beside the "Show to"
 * rule in the Visibility view; an element renders only when both pass. It
 * protects nothing: anyone can add a query string to an address.
 */
import { useId } from 'react'
import { readShowIf, SHOW_IF_PROP_KEY, type ShowIfSource, type ShowIfTest } from '@core/templates'
import { useEditorStore } from '@site/store/store'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import styles from './ShowWhenControl.module.css'

type SourceChoice = 'always' | ShowIfSource

const SOURCE_OPTIONS: Array<{ value: SourceChoice; label: string }> = [
  { value: 'always', label: 'Always' },
  { value: 'query', label: 'A query parameter of the address' },
  { value: 'entry', label: 'A field of the loop item or entry' },
]

const TEST_OPTIONS: Array<{ value: ShowIfTest; label: string }> = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'filled', label: 'has a value' },
  { value: 'empty', label: 'is empty' },
]

const NAME_PLACEHOLDER: Record<ShowIfSource, string> = {
  query: 'commerce',
  entry: 'status',
}

const HINT: Record<SourceChoice, string> = {
  always: 'The element is in the page whatever the address or data say.',
  query: 'Read from the address the visitor opened, like ?commerce=plan_changed. The element renders when the page is requested, and anyone can add a query string, so this hides nothing private.',
  entry: 'Read from the item a loop is repeating, or the entry an entry template shows. Each item is tested on its own.',
}

/** What the author is editing: the stored condition, readable or not. */
interface Draft {
  source: ShowIfSource
  name: string
  test: ShowIfTest
  value: string
}

function readDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.source !== 'query' && r.source !== 'entry') return null
  const test = TEST_OPTIONS.some((option) => option.value === r.test) ? (r.test as ShowIfTest) : 'equals'
  return {
    source: r.source,
    name: typeof r.name === 'string' ? r.name : '',
    test,
    value: typeof r.value === 'string' ? r.value : '',
  }
}

function isSourceChoice(value: string): value is SourceChoice {
  return SOURCE_OPTIONS.some((option) => option.value === value)
}

function isTest(value: string): value is ShowIfTest {
  return TEST_OPTIONS.some((option) => option.value === value)
}

function needsValue(test: ShowIfTest): boolean {
  return test === 'equals' || test === 'notEquals'
}

export function ShowIfControl({
  nodeId,
  props,
  readOnly,
}: {
  nodeId: string
  props: Record<string, unknown>
  readOnly: boolean
}) {
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const sourceId = useId()
  const nameId = useId()
  const testId = useId()
  const valueId = useId()
  const draft = readDraft(props[SHOW_IF_PROP_KEY])
  const rule = readShowIf(props)
  const choice: SourceChoice = draft?.source ?? 'always'

  // An unfinished condition (no name yet) is stored as typed; the publisher
  // reads it as "never", which is the safe side, and the hint says so.
  function save(next: Draft | undefined) {
    updateNodeProps(nodeId, {
      [SHOW_IF_PROP_KEY]: next
        ? {
            source: next.source,
            name: next.name,
            test: next.test,
            ...(needsValue(next.test) ? { value: next.value } : {}),
          }
        : undefined,
    })
  }

  function pickSource(next: SourceChoice) {
    if (next === 'always') save(undefined)
    else save({ source: next, name: draft?.name ?? '', test: draft?.test ?? 'equals', value: draft?.value ?? '' })
  }

  const broken = rule === 'never'
  const hint = !draft
    ? HINT.always
    : draft.name.trim() === ''
      ? 'Name what to test. Until then nobody gets this element.'
      : broken
        ? 'This condition could not be read, so nobody gets the element. Use letters, digits, dots, dashes or underscores in the name.'
        : HINT[draft.source]

  return (
    <section className={styles.root} aria-label="Show-if condition" data-testid="show-if-control">
      <label htmlFor={sourceId} className={styles.label}>Show if</label>
      <Select
        id={sourceId}
        fieldSize="sm"
        value={choice}
        options={SOURCE_OPTIONS}
        disabled={readOnly}
        onChange={(event) => {
          const next = event.currentTarget.value
          if (isSourceChoice(next)) pickSource(next)
        }}
      />
      {draft && (
        <>
          <label htmlFor={nameId} className={styles.label}>
            {draft.source === 'query' ? 'Parameter' : 'Field'}
          </label>
          <Input
            id={nameId}
            fieldSize="sm"
            value={draft.name}
            placeholder={NAME_PLACEHOLDER[draft.source]}
            disabled={readOnly}
            onChange={(event) => save({ ...draft, name: event.currentTarget.value.trim() })}
          />
          <label htmlFor={testId} className={styles.label}>Test</label>
          <Select
            id={testId}
            fieldSize="sm"
            value={draft.test}
            options={TEST_OPTIONS}
            disabled={readOnly}
            onChange={(event) => {
              const next = event.currentTarget.value
              if (isTest(next)) save({ ...draft, test: next })
            }}
          />
          {needsValue(draft.test) && (
            <>
              <label htmlFor={valueId} className={styles.label}>Value</label>
              <Input
                id={valueId}
                fieldSize="sm"
                value={draft.value}
                placeholder={draft.source === 'query' ? 'plan_changed' : 'active'}
                disabled={readOnly}
                onChange={(event) => save({ ...draft, value: event.currentTarget.value })}
              />
            </>
          )}
        </>
      )}
      <p className={styles.hint} data-tone={draft && (broken || draft.name.trim() === '') ? 'danger' : undefined}>
        {hint}
      </p>
    </section>
  )
}
