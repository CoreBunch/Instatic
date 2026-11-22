/**
 * The canvas keeps CSS for classes a module declares it emits, including when
 * the module registers after the canvas mounted (a plugin module pack loads
 * asynchronously and changes nothing in the editor store).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { classKindSelector, DEFAULT_BREAKPOINTS, type StyleRule } from '@core/page-tree'
import { pluginModuleToHostModule } from '@core/plugins/moduleAdapter'
import type { PluginModuleDefinition } from '@core/plugin-sdk'
import { makeNode, makePage, makeSite } from '../fixtures'

const CHECKOUT_RULE: StyleRule = {
  id: 'rule-checkout',
  name: 'commerce-checkout',
  kind: 'class',
  selector: classKindSelector('commerce-checkout'),
  order: 0,
  styles: { color: 'rgb(1, 2, 3)' },
  contextStyles: {},
  createdAt: 0,
  updatedAt: 0,
}

function resetEditorStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    previewClassStyles: null,
    activeClassId: null,
    selectedNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const injectedCss = () => document.head.querySelector<HTMLStyleElement>('style#mc-classes')?.textContent ?? ''

describe('ClassStyleInjector module-emitted classes', () => {
  beforeEach(() => {
    cleanup()
    document.head.replaceChildren()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
    document.head.replaceChildren()
    resetEditorStore()
    if (registry.has('acme.checkout')) registry.unregister('acme.checkout')
  })

  it('adds the CSS once a declaring module registers after mount', async () => {
    render(<ClassStyleInjector targetDocument={document} />)
    await act(async () => {
      const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['checkout'] })
      const checkout = makeNode({ id: 'checkout', moduleId: 'acme.checkout' })
      useEditorStore.setState({
        site: makeSite({
          breakpoints: DEFAULT_BREAKPOINTS,
          pages: [makePage({ nodes: { root, checkout } })],
          styleRules: { [CHECKOUT_RULE.id]: CHECKOUT_RULE },
        }),
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    expect(injectedCss()).not.toContain('.commerce-checkout')

    await act(async () => {
      registry.registerOrReplace(pluginModuleToHostModule('acme', {
        id: 'acme.checkout',
        name: 'Checkout',
        category: 'Commerce',
        version: '1.0.0',
        defaults: {},
        schema: {},
        emittedClassNames: ['commerce-checkout*'],
        render: () => ({ html: '<div class="commerce-checkout"></div>' }),
      } as PluginModuleDefinition, () => () => null, []))
    })

    await waitFor(() => expect(injectedCss()).toContain('.commerce-checkout'))
  })
})
