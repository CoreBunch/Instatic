import {
  Children,
  isValidElement,
  type OptionHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'

export interface SelectOption {
  value: string | number
  label: ReactNode
  textValue?: string
  icon?: ReactNode
  disabled?: boolean
  placeholder?: boolean
}

export interface NormalizedSelectOption {
  value: string
  label: ReactNode
  textValue: string
  icon?: ReactNode
  disabled?: boolean
  placeholder?: boolean
  /**
   * Non-interactive group-header row (emitted from an `<optgroup label>`). It
   * is rendered as a heading and skipped by selection, keyboard navigation, and
   * search filtering.
   */
  header?: boolean
}

/** A real, selectable option — not a disabled item and not a group header. */
function isSelectableOption(option: NormalizedSelectOption): boolean {
  return !option.disabled && !option.header
}

export function stringifySelectValue(value: unknown): string {
  if (Array.isArray(value)) return stringifySelectValue(value[0])
  if (value === undefined || value === null) return ''
  return String(value)
}

export function hasTextValue(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function getNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getNodeText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return getNodeText(props.children)
  }
  return ''
}

export function normalizeOptions(
  options: SelectOption[] | undefined,
  children: ReactNode,
): NormalizedSelectOption[] {
  if (options) {
    return options.map((option) => ({
      ...option,
      value: stringifySelectValue(option.value),
      textValue: option.textValue ?? getNodeText(option.label),
    }))
  }
  return Children.toArray(children).flatMap(optionFromChild)
}

function optionFromChild(child: ReactNode): NormalizedSelectOption[] {
  if (!isValidElement(child)) return []
  if (child.type === 'optgroup') {
    const props = child.props as { label?: string; children?: ReactNode }
    const groupItems = Children.toArray(props.children).flatMap(optionFromChild)
    if (groupItems.length === 0) return []
    const label = props.label ?? ''
    const header: NormalizedSelectOption = {
      value: `__group__:${label}`,
      label,
      textValue: label,
      header: true,
    }
    return [header, ...groupItems]
  }
  if (child.type !== 'option') return []

  const option = child as ReactElement<OptionHTMLAttributes<HTMLOptionElement>>
  const textValue = getNodeText(option.props.children)
  return [{
    value: stringifySelectValue(option.props.value ?? textValue),
    label: option.props.children,
    textValue,
    disabled: option.props.disabled,
  }]
}

export function getOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

export function isEnabledOptionIndex(
  options: NormalizedSelectOption[],
  index: number,
): boolean {
  return index >= 0 && index < options.length && isSelectableOption(options[index])
}

export function getFirstEnabledOptionIndex(options: NormalizedSelectOption[]): number {
  return options.findIndex(isSelectableOption)
}

export function getLastEnabledOptionIndex(options: NormalizedSelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index--) {
    if (isSelectableOption(options[index])) return index
  }
  return -1
}

export function getInitialActiveIndex(
  options: NormalizedSelectOption[],
  selectedValue: string,
): number {
  const selectedIndex = options.findIndex(
    (option) => option.value === selectedValue && isSelectableOption(option),
  )
  return selectedIndex >= 0 ? selectedIndex : getFirstEnabledOptionIndex(options)
}

export function getNextEnabledOptionIndex(
  options: NormalizedSelectOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1
  const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : options.length

  for (let step = 1; step <= options.length; step++) {
    const nextIndex = (startIndex + direction * step + options.length) % options.length
    if (isSelectableOption(options[nextIndex])) return nextIndex
  }

  return -1
}
