import { describe, expect, it } from 'bun:test'
import {
  SiteValidationError,
  validateVisualComponents,
  validateVisualComponentsForPartialWrite,
} from '@core/persistence/validate'
import type { VisualComponent } from '@core/visualComponents'

/**
 * Full-roster write = the partial-write validator with an empty stored
 * roster: every component is "changed", nothing is merged in. The old
 * dedicated full-write validator was deleted in favour of this shape.
 */
function validateVisualComponentsForWrite(rawVCs: unknown[]): VisualComponent[] {
  return validateVisualComponentsForPartialWrite(rawVCs, [], new Set<string>())
}

function vc(overrides: Partial<VisualComponent> = {}): VisualComponent {
  return {
    id: 'vc-card',
    name: 'Card',
    tree: {
      rootNodeId: 'root',
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.body',
          props: {},
          breakpointOverrides: {},
          children: [],
          classIds: [],
        },
      },
    },
    params: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function refNode(id: string, componentId: string) {
  return {
    id,
    moduleId: 'base.visual-component-ref',
    props: { componentId },
    breakpointOverrides: {},
    children: [],
    classIds: [],
  }
}

describe('validateVisualComponentsForPartialWrite (full-roster mode)', () => {
  it('preserves valid Visual Components', () => {
    const components = validateVisualComponentsForWrite([vc()])

    expect(components).toHaveLength(1)
    expect(components[0].id).toBe('vc-card')
  })

  it('rejects malformed entries instead of silently dropping them', () => {
    expect(() =>
      validateVisualComponentsForWrite([
        vc(),
        {
          id: 'vc-broken',
          name: 'Broken',
          tree: { rootNodeId: 'missing-root', nodes: {} },
          params: [],
          classIds: [],
          createdAt: 1_700_000_000_000,
        },
      ]),
    ).toThrow(SiteValidationError)
  })

  it('rejects duplicate names instead of first-wins deduping', () => {
    expect(() =>
      validateVisualComponentsForWrite([
        vc({ id: 'vc-one', name: 'Card' }),
        vc({ id: 'vc-two', name: 'Card' }),
      ]),
    ).toThrow(/duplicate/i)
  })

  it('rejects missing component refs instead of stripping them', () => {
    expect(() =>
      validateVisualComponentsForWrite([
        vc({
          tree: {
            rootNodeId: 'root',
            nodes: {
              root: {
                id: 'root',
                moduleId: 'base.body',
                props: {},
                breakpointOverrides: {},
                children: ['missing-ref'],
                classIds: [],
              },
              'missing-ref': refNode('missing-ref', 'vc-missing'),
            },
          },
        }),
      ]),
    ).toThrow(/missing Visual Component/i)
  })

  it('rejects VC trees whose child ids do not resolve', () => {
    expect(() =>
      validateVisualComponentsForWrite([
        vc({
          tree: {
            rootNodeId: 'root',
            nodes: {
              root: {
                id: 'root',
                moduleId: 'base.body',
                props: {},
                breakpointOverrides: {},
                children: ['missing-child'],
                classIds: [],
              },
            },
          },
        }),
      ]),
    ).toThrow(/child node "missing-child" not found/i)
  })

  it('rejects VC trees with internal child cycles', () => {
    expect(() =>
      validateVisualComponentsForWrite([
        vc({
          tree: {
            rootNodeId: 'root',
            nodes: {
              root: {
                id: 'root',
                moduleId: 'base.body',
                props: {},
                breakpointOverrides: {},
                children: ['child'],
                classIds: [],
              },
              child: {
                id: 'child',
                moduleId: 'base.container',
                props: {},
                breakpointOverrides: {},
                children: ['root'],
                classIds: [],
              },
            },
          },
        }),
      ]),
    ).toThrow(/cycle detected/i)
  })

  it('rejects dependency cycles instead of dropping cyclic components', () => {
    const first = vc({
      id: 'vc-one',
      name: 'One',
      tree: {
        rootNodeId: 'root-one',
        nodes: {
          'root-one': {
            id: 'root-one',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: ['ref-two'],
            classIds: [],
          },
          'ref-two': refNode('ref-two', 'vc-two'),
        },
      },
    })
    const second = vc({
      id: 'vc-two',
      name: 'Two',
      tree: {
        rootNodeId: 'root-two',
        nodes: {
          'root-two': {
            id: 'root-two',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: ['ref-one'],
            classIds: [],
          },
          'ref-one': refNode('ref-one', 'vc-one'),
        },
      },
    })

    expect(() => validateVisualComponentsForWrite([first, second])).toThrow(/cycle/i)
  })

  it('keeps read validation tolerant for corrupted persisted components', () => {
    const components = validateVisualComponents([
      vc(),
      { id: 'vc-broken', name: 'Broken', tree: { rootNodeId: 'missing-root', nodes: {} } },
    ])

    expect(components).toHaveLength(1)
    expect(components[0].id).toBe('vc-card')
  })

  it('drops persisted components with invalid tree invariants on read', () => {
    const components = validateVisualComponents([
      vc(),
      vc({
        id: 'vc-corrupt',
        name: 'Corrupt',
        tree: {
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'base.body',
              props: {},
              breakpointOverrides: {},
              children: ['missing-child'],
              classIds: [],
            },
          },
        },
      }),
    ])

    expect(components).toHaveLength(1)
    expect(components[0].id).toBe('vc-card')
  })
})
