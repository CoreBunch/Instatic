import type { StyleRule } from './styleRule'

function isNodeScopedClass(cls: StyleRule | null | undefined, nodeId?: string): boolean {
  if (cls?.scope?.type !== 'node') return false
  return nodeId ? cls.scope.nodeId === nodeId : true
}

export function isUserVisibleClass(cls: StyleRule | null | undefined): boolean {
  return !!cls && !cls.atRule && !isNodeScopedClass(cls)
}

export function isGeneratedClass(cls: StyleRule | null | undefined): boolean {
  return cls?.generated?.origin === 'framework'
}

export function isGeneratedClassLocked(cls: StyleRule | null | undefined): boolean {
  return cls?.generated?.locked === true
}

export function generatedClassKindLabel(cls: StyleRule | null | undefined): string | null {
  if (!isGeneratedClass(cls)) return null
  return 'Utility'
}
