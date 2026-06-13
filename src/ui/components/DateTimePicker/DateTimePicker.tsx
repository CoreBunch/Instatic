/**
 * DateTimePicker — calendar grid + time spinner primitive.
 *
 * Shared admin primitive for picking a wall-clock datetime. Used by the
 * page/post schedule-publish dialog (`SchedulePublishDialog`) and any
 * future surface that needs a custom datetime picker (date filters,
 * scheduling reports, etc.).
 *
 * Layout: a fixed two-pane card.
 *
 *   ┌────────────────────────┬──────────┐
 *   │   < May 2026 >         │   Time   │
 *   │  Mo Tu We Th Fr Sa Su  │ ┌──────┐ │
 *   │   1  2  3  4  5  6  7  │ │ 14 : │ │
 *   │   8  9 10 11 12 13 14  │ │ 30   │ │
 *   │  …                     │ └──────┘ │
 *   ├────────────────────────┴──────────┤
 *   │              [Cancel] [Confirm]   │
 *   └───────────────────────────────────┘
 *
 * Local datetime semantics: the picker reads/writes wall-clock fields
 * in the user's local timezone. The caller decides whether to keep the
 * Date as-is (local) or convert to ISO/UTC via `.toISOString()`. For
 * scheduling we ISO-ify at the call site so the server stores UTC.
 *
 * A11y: arrow-key navigation in the day grid, Enter to confirm,
 * Esc to cancel (consumer wires Esc via the dialog wrapper). The day
 * grid is a proper `role="grid"` with `gridcell` items.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { ChevronLeftIcon } from 'pixel-art-icons/icons/chevron-left'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import styles from './DateTimePicker.module.css'

// ---------------------------------------------------------------------------
// Date math (local time, no library — small surface, easy to maintain)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

/** Days in a 0-indexed month, accounting for leap years on Feb. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/**
 * Weekday of the first of a month, 0=Mon … 6=Sun. JS `Date.getDay()`
 * returns 0=Sun … 6=Sat — we shift so Monday is the first column.
 */
function firstWeekdayMondayBased(year: number, month: number): number {
  const dow = new Date(year, month, 1).getDay()
  return (dow + 6) % 7
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function combine(dayDate: Date, hour: number, minute: number): Date {
  return new Date(
    dayDate.getFullYear(),
    dayDate.getMonth(),
    dayDate.getDate(),
    hour,
    minute,
    0,
    0,
  )
}

function clampHour(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 23) return 23
  return Math.floor(value)
}

function clampMinute(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 59) return 59
  return Math.floor(value)
}

// ---------------------------------------------------------------------------
// Cell model
// ---------------------------------------------------------------------------

interface DayCell {
  /** Date this cell represents (always a real Date, no nulls). */
  date: Date
  /** Whether this cell belongs to the currently-viewed month. */
  isCurrentMonth: boolean
}

/**
 * Build the 6×7 grid for a given (year, month). Returns 42 cells —
 * leading days from the previous month, then current month, then
 * trailing days from the next month. Always 42 cells so the grid's
 * height stays constant across months (matches MacOS Calendar).
 */
function buildMonthCells(year: number, month: number): DayCell[] {
  const totalCells = 42
  const firstDow = firstWeekdayMondayBased(year, month)
  const daysCurrent = daysInMonth(year, month)
  // Previous-month tail: days before the first-of-month, in DOM order.
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const daysPrev = daysInMonth(prevYear, prevMonth)

  const cells: DayCell[] = []
  for (let i = 0; i < firstDow; i++) {
    const dayNumber = daysPrev - firstDow + 1 + i
    cells.push({
      date: new Date(prevYear, prevMonth, dayNumber),
      isCurrentMonth: false,
    })
  }
  for (let d = 1; d <= daysCurrent; d++) {
    cells.push({ date: new Date(year, month, d), isCurrentMonth: true })
  }
  // Next-month head: fill the remainder.
  const remainder = totalCells - cells.length
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year
  for (let d = 1; d <= remainder; d++) {
    cells.push({ date: new Date(nextYear, nextMonth, d), isCurrentMonth: false })
  }
  return cells
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DateTimePickerProps {
  /**
   * Current value. `null` initialises the picker to "today at the next
   * sensible time" (rounded up to the next 5-minute mark) without
   * committing — the caller still gets `null` back until the user
   * confirms.
   */
  value: Date | null
  /** Confirm handler — called when the user clicks "Confirm". */
  onConfirm: (next: Date) => void
  /** Cancel handler — called when the user clicks "Cancel" or hits Esc. */
  onCancel: () => void
  /**
   * Earliest selectable day. Days strictly before this date are
   * disabled in the grid. For scheduling, the caller passes "today"
   * so users can't schedule a publish in the past.
   */
  minDate?: Date
  /**
   * Optional aria-label override. Defaults to "Date and time picker".
   */
  ariaLabel?: string
}

/** Round a Date forward to the next 5-minute boundary. */
function defaultInitialDate(): Date {
  const now = new Date()
  const minutes = now.getMinutes()
  const rounded = Math.ceil((minutes + 1) / 5) * 5
  if (rounded >= 60) {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours() + 1,
      0,
      0,
      0,
    )
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    rounded,
    0,
    0,
  )
}

export function DateTimePicker({
  value,
  onConfirm,
  onCancel,
  minDate,
  ariaLabel = 'Date and time picker',
}: DateTimePickerProps) {
  const initial = value ?? defaultInitialDate()

  // Internal state — confirms commit via `onConfirm`; closing without
  // confirming throws the changes away.
  const [selected, setSelected] = useState<Date>(initial)
  const [viewYear, setViewYear] = useState(initial.getFullYear())
  const [viewMonth, setViewMonth] = useState(initial.getMonth())

  const today = (() => {
    const t = new Date()
    return new Date(t.getFullYear(), t.getMonth(), t.getDate())
  })()

  const minDay = minDate
    ? new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate())
    : null

  const cells = buildMonthCells(viewYear, viewMonth)

  const gridRef = useRef<HTMLDivElement | null>(null)

  // Focus the currently-selected day on mount so arrow-key nav works.
  useEffect(() => {
    if (!gridRef.current) return
    const el = gridRef.current.querySelector<HTMLButtonElement>('[data-selected="true"]')
    if (el) el.focus({ preventScroll: true })
  }, [])

  function goPrevMonth() {
    if (viewMonth === 0) {
      setViewYear(viewYear - 1)
      setViewMonth(11)
    } else {
      setViewMonth(viewMonth - 1)
    }
  }

  function goNextMonth() {
    if (viewMonth === 11) {
      setViewYear(viewYear + 1)
      setViewMonth(0)
    } else {
      setViewMonth(viewMonth + 1)
    }
  }

  function handlePickDay(cell: DayCell) {
    if (minDay && cell.date < minDay) return
    const next = combine(cell.date, selected.getHours(), selected.getMinutes())
    setSelected(next)
    if (!cell.isCurrentMonth) {
      setViewYear(cell.date.getFullYear())
      setViewMonth(cell.date.getMonth())
    }
  }

  function handleGridKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Arrow-key navigation: ±1 day for left/right, ±7 days for up/down.
    let delta: number
    if (e.key === 'ArrowLeft') delta = -1
    else if (e.key === 'ArrowRight') delta = 1
    else if (e.key === 'ArrowUp') delta = -7
    else if (e.key === 'ArrowDown') delta = 7
    else if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
      return
    } else return
    e.preventDefault()
    const next = new Date(selected)
    next.setDate(next.getDate() + delta)
    if (minDay && next < minDay) return
    setSelected(next)
    setViewYear(next.getFullYear())
    setViewMonth(next.getMonth())
  }

  // Hour/minute spinners — clamp on change, allow direct typing.
  const handleHourChange = (raw: string) => {
    const v = clampHour(parseInt(raw, 10))
    setSelected((prev) => combine(prev, v, prev.getMinutes()))
  }

  const handleMinuteChange = (raw: string) => {
    const v = clampMinute(parseInt(raw, 10))
    setSelected((prev) => combine(prev, prev.getHours(), v))
  }

  function bumpHour(delta: number) {
    setSelected((prev) => {
      const next = clampHour(prev.getHours() + delta)
      return combine(prev, next, prev.getMinutes())
    })
  }

  function bumpMinute(delta: number) {
    setSelected((prev) => {
      // Snap to multiples of 5 when stepping via the chevrons.
      const stepped = Math.round(prev.getMinutes() / 5) * 5 + delta * 5
      const next = ((stepped % 60) + 60) % 60
      return combine(prev, prev.getHours(), next)
    })
  }

  function handleConfirm() {
    onConfirm(selected)
  }

  const monthLabel = `${MONTH_NAMES[viewMonth]} ${viewYear}`

  return (
    <div
      className={styles.root}
      role="dialog"
      aria-label={ariaLabel}
      // Pre-fill `--current-week-col` so the active week row gets a
      // subtle highlight in CSS. Computed from selected day below.
      style={
        {
          ['--picker-selected-day' as string]: String(selected.getDate()),
        } as CSSProperties
      }
    >
      <div className={styles.split}>
        <section className={styles.calendar} aria-label="Calendar">
          <header className={styles.monthHeader}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Previous month"
              onClick={goPrevMonth}
            >
              <ChevronLeftIcon size={12} aria-hidden="true" />
            </Button>
            <span className={styles.monthLabel} aria-live="polite">{monthLabel}</span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Next month"
              onClick={goNextMonth}
            >
              <ChevronRightIcon size={12} aria-hidden="true" />
            </Button>
          </header>

          <div className={styles.weekdayRow} aria-hidden="true">
            {DAY_LABELS.map((label) => (
              <span key={label} className={styles.weekdayLabel}>{label}</span>
            ))}
          </div>

          <div
            ref={gridRef}
            className={styles.dayGrid}
            role="grid"
            aria-label={`${monthLabel} days`}
            onKeyDown={handleGridKey}
          >
            {cells.map((cell, idx) => {
              const isToday = isSameLocalDay(cell.date, today)
              const isSelected = isSameLocalDay(cell.date, selected)
              const isBeforeMin = minDay !== null && cell.date < minDay
              // BTN-3 §8 exception below — see DateTimePicker allowlist
              // entry in `button-primitive-usage.test.ts`.
              return (
                <button
                  key={idx}
                  type="button"
                  role="gridcell"
                  tabIndex={isSelected ? 0 : -1}
                  data-current={cell.isCurrentMonth ? 'true' : 'false'}
                  data-today={isToday ? 'true' : undefined}
                  data-selected={isSelected ? 'true' : undefined}
                  data-disabled={isBeforeMin ? 'true' : undefined}
                  className={cn(
                    styles.dayCell,
                    !cell.isCurrentMonth && styles.dayCellOutside,
                    isToday && styles.dayCellToday,
                    isSelected && styles.dayCellSelected,
                    isBeforeMin && styles.dayCellDisabled,
                  )}
                  disabled={isBeforeMin}
                  aria-label={cell.date.toDateString()}
                  aria-selected={isSelected}
                  onClick={() => handlePickDay(cell)}
                >
                  {cell.date.getDate()}
                </button>
              )
            })}
          </div>
        </section>

        <section className={styles.timeColumn} aria-label="Time">
          <div className={styles.timeLabel}>Time</div>
          <div className={styles.timeSpinners}>
            <TimeSpinner
              label="Hours"
              value={selected.getHours()}
              onChange={handleHourChange}
              onBump={bumpHour}
              max={23}
            />
            <span className={styles.timeColon} aria-hidden="true">:</span>
            <TimeSpinner
              label="Minutes"
              value={selected.getMinutes()}
              onChange={handleMinuteChange}
              onBump={bumpMinute}
              max={59}
            />
          </div>
          <p className={styles.timeHelp}>24-hour · local time</p>
        </section>
      </div>

      <footer className={styles.footer}>
        <span className={styles.summary} aria-live="polite">
          {selected.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
          {' · '}
          {selected.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </span>
        <div className={styles.footerActions}>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleConfirm}>Confirm</Button>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Time spinner sub-component
// ---------------------------------------------------------------------------

interface TimeSpinnerProps {
  label: string
  value: number
  onChange: (raw: string) => void
  onBump: (delta: number) => void
  max: number
}

function TimeSpinner({ label, value, onChange, onBump, max: _max }: TimeSpinnerProps) {
  // 2-digit display ("04", "59"). `value` is the source of truth; the
  // input is controlled so users can clear / type freely while the
  // displayed digits update on every render.
  const display = String(value).padStart(2, '0')
  return (
    <div className={styles.spinner}>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        aria-label={`Increase ${label.toLowerCase()}`}
        onClick={() => onBump(1)}
      >
        <ChevronUpIcon size={10} aria-hidden="true" />
      </Button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className={styles.spinnerInput}
        value={display}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        aria-label={`Decrease ${label.toLowerCase()}`}
        onClick={() => onBump(-1)}
      >
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>
    </div>
  )
}
