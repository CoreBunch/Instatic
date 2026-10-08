import { useEffect, useRef } from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { htmlAttributesForReact } from '@core/htmlAttributes'
import type { DisclosureStoredProps } from './props'
import { installDisclosureBehavior } from './behavior'

export function DisclosureEditor({ props, children, mcClassName, nodeWrapperProps }: ModuleComponentProps<DisclosureStoredProps>) {
  const root = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (root.current) return installDisclosureBehavior(root.current.ownerDocument)
  }, [])

  return (
    <details
      {...nodeWrapperProps}
      {...htmlAttributesForReact(props.htmlAttributes)}
      ref={root}
      className={mcClassName}
      name={props.group || undefined}
      open={props.initiallyOpen}
      data-instatic-disclosure=""
      data-instatic-close-on-escape={String(props.closeOnEscape)}
      data-instatic-close-on-outside-pointer={String(props.closeOnOutsidePointer)}
      data-instatic-close-on-focus-leave={String(props.closeOnFocusLeave)}
    >
      <summary>{props.label}</summary>
      {children}
    </details>
  )
}
