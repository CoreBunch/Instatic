/**
 * ShowIfControl: render an element only when a query parameter of the page
 * address, or a field of the loop item (or entry), passes a test.
 *
 * The condition lives on the node as the `showIf` prop and is applied on the
 * server (`@core/templates` → `showIfAllows`). It sits beside the "Show to"
 * rule in the Visibility view; an element renders only when both pass. It
 * protects nothing: anyone can add a query string to an address.
 */
import { useId, useState } from 'react'
import {
  readShowIf,
  SHOW_IF_NAME_REGEX,
  SHOW_IF_PROP_KEY,
  SHOW_IF_VALUE_MAX_LENGTH,
  subtreeHasOutlet,
  type ShowIfSource,
  type ShowIfTest,
} from '@core/templates'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import styles from './ShowIfControl.module.css'

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
  query: 'Read from the address the visitor opened, like ?commerce=plan_changed. The element renders when the page is requested, and anyone can add a query string, so this hides nothing private. Bracketed names like filter[status] cannot be tested.',
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

/**
 * A text field that edits a local draft and saves it on blur or Enter, so a
 * condition is one store write (one undo step) per edit, not one per key.
 * The parent keys it by the stored value, so an outside change (undo, a
 * collaborator) resets the draft.
 */
function DraftInput({
  id,
  value,
  placeholder,
  disabled,
  normalize,
  onCommit,
}: {
  id: string
  value: string
  placeholder: string
  disabled: boolean
  normalize?: (raw: string) => string
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  function commit() {
    const next = normalize ? normalize(draft) : draft
    if (next !== value) onCommit(next)
  }
  return (
    <Input
      id={id}
      fieldSize="sm"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
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
  // The outlet is where a page or an entry is placed, and it is rendered with
  // the template around it. A condition here would turn the wrapper into a
  // request-time fragment rendered from the template alone, so the content
  // would come out empty. The publisher drops such a condition
  // (`withoutShowIfAroundOutlet`); the control is off here to match.
  const holdsOutlet = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page ? subtreeHasOutlet(page.nodes, nodeId) : false
  })
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

  const nameIsValid = draft !== null && SHOW_IF_NAME_REGEX.test(draft.name)
  const valueTooLong = draft !== null && needsValue(draft.test) && draft.value.length > SHOW_IF_VALUE_MAX_LENGTH
  const problem = draft === null
    ? null
    : holdsOutlet
      ? 'This element holds the page content, so a condition here is ignored when the page is published. Set it back to Always, and put the condition on an element inside the page.'
      : draft.name === ''
        ? 'Name what to test. Until then nobody gets this element.'
        : !nameIsValid
          ? 'Use letters, digits, dots, dashes or underscores in the name. Until then nobody gets this element.'
          : valueTooLong
            ? `Keep the value to ${SHOW_IF_VALUE_MAX_LENGTH} characters. Until then nobody gets this element.`
            : rule === 'never'
              ? 'This condition could not be read, so nobody gets the element. Pick an option to fix it.'
              : null
  const hint = holdsOutlet && draft === null
    ? 'This element holds the page content, so it cannot have a condition. Put one on an element inside the page.'
    : problem ?? HINT[choice]
  const locked = readOnly || (holdsOutlet && draft === null)

  return (
    <section className={styles.root} aria-label="Show-if condition" data-testid="show-if-control">
      <label htmlFor={sourceId} className={styles.label}>Show if</label>
      <Select
        id={sourceId}
        fieldSize="sm"
        value={choice}
        options={SOURCE_OPTIONS}
        disabled={locked}
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
          <DraftInput
            key={draft.name}
            id={nameId}
            value={draft.name}
            placeholder={NAME_PLACEHOLDER[draft.source]}
            disabled={locked}
            normalize={(raw) => raw.trim()}
            onCommit={(name) => save({ ...draft, name })}
          />
          <label htmlFor={testId} className={styles.label}>Test</label>
          <Select
            id={testId}
            fieldSize="sm"
            value={draft.test}
            options={TEST_OPTIONS}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.value
              if (isTest(next)) save({ ...draft, test: next })
            }}
          />
          {needsValue(draft.test) && (
            <>
              <label htmlFor={valueId} className={styles.label}>Value</label>
              <DraftInput
                key={draft.value}
                id={valueId}
                value={draft.value}
                placeholder={draft.source === 'query' ? 'plan_changed' : 'active'}
                disabled={locked}
                onCommit={(value) => save({ ...draft, value })}
              />
            </>
          )}
        </>
      )}
      <p className={styles.hint} data-tone={problem ? 'danger' : undefined}>
        {hint}
      </p>
    </section>
  )
}
