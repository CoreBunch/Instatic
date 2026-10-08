import type { PageNode } from '@core/page-tree'

/** Explicit selected placeholders remain selected; implicit choices skip disabled options. */
export function resolveSelectInitialValue(select: PageNode, readNode: (id: string) => PageNode | undefined): string | string[] {
  const options: { value: string; selected: boolean; disabled: boolean }[] = []
  function visit(id: string, disabled: boolean) {
    const node = readNode(id)
    if (!node) return
    disabled ||= node.props.disabled === true
    if (node.moduleId === 'base.option') options.push({ value: String(node.props.value ?? ''), selected: node.props.selected === true, disabled })
    else for (const child of node.children) visit(child, disabled)
  }
  for (const child of select.children) visit(child, false)
  if (select.props.multiple) return options.filter((option) => option.selected && !option.disabled).map((option) => option.value)
  return options.findLast((option) => option.selected)?.value ?? options.find((option) => !option.disabled)?.value ?? ''
}
