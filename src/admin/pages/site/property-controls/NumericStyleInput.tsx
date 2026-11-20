import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Input, InputStepper } from '@ui/components/Input'

interface NumericStyleProps extends ComponentProps<typeof Input> {
  onAdjust?: (value: string) => void
  onScrubPreview?: (value: string) => void
  onClearPreview?: () => void
  defaultUnit?: string
  showStepper?: boolean
  increment?: number
}

/** Preserve authored CSS units. Keywords, token references and expressions remain text-editable. */
export function NumericStyleInput({ onAdjust, onScrubPreview, onClearPreview, value, placeholder, increment = 1, defaultUnit = '', showStepper = true, min, max, ...props }: NumericStyleProps) {
  const [preview, setPreview] = useState<string | null>(null)
  const gesture = useRef<{ x: number; id: number; start: string; result: string | null; clear?: () => void } | null>(null)
  useEffect(() => () => { gesture.current?.clear?.() }, [])
  const source = String(value === '' || value == null ? placeholder ?? '' : value).trim()
  const numeric = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i
  function adjust(base: string, steps: number) {
    const match = numeric.exec(base)
    if (!match) return base
    const next = Math.max(Number(min ?? -Infinity), Math.min(Number(max ?? Infinity), Number(match[1]) + steps * increment))
    return Number(next.toFixed(6)) + (match[2] || defaultUnit)
  }
  if (!onAdjust) {
    return <Input {...props} value={value} placeholder={placeholder} min={min} max={max} />
  }
  const adjustable = numeric.test(source) && !props.readOnly && !props.disabled
  function cancel() {
    gesture.current?.clear?.()
    gesture.current = null
    setPreview(null)
  }
  return <Input {...props} value={preview ?? value} placeholder={placeholder} data-scrubbable={adjustable || undefined}
    onPointerDown={(event) => {
      if (!adjustable || event.button !== 0 || !event.isPrimary || gesture.current) return
      gesture.current = { x: event.clientX, start: source, id: event.pointerId, result: null }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      const drag = gesture.current
      if (!drag || drag.id !== event.pointerId) return
      const steps = Math.trunc((event.clientX - drag.x) / 4)
      if (!steps && drag.result === null) return
      const next = adjust(drag.start, steps * (event.shiftKey ? 10 : 1))
      if (next === drag.result) return
      drag.result = next
      drag.clear = onClearPreview
      setPreview(next)
      onScrubPreview?.(next)
    }}
    onPointerUp={(event) => {
      const drag = gesture.current
      if (drag?.id !== event.pointerId) return
      if (drag.result !== null) onAdjust(drag.result)
      cancel()
    }}
    onLostPointerCapture={cancel}
    onPointerCancel={cancel}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && gesture.current?.result != null) {
        event.preventDefault()
        cancel()
        return
      }
      if (adjustable && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        onAdjust(adjust(source, (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1)))
      } else props.onKeyDown?.(event)
    }}
    trailingSlot={showStepper ? (
      <InputStepper label={props['aria-label'] ?? 'value'} hidden={!adjustable}
        onStep={(steps) => onAdjust(adjust(source, steps))} />
    ) : undefined}
  />
}
