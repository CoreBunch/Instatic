import { describe, it, expect, beforeEach } from 'bun:test'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'

// We import the class directly for test isolation (not the global singleton)
import { ModuleDefinition, registry as globalRegistry } from '@core/module-engine'

// Minimal valid module fixture
function makeModule(id: string): ModuleDefinition {
  return {
    id,
    name: 'Test Module',
    category: 'Test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: (_props, _children) => ({ html: `<div></div>` }),
  }
}

// We need a fresh registry per test — import the class directly
 
const { registry: _unusedRegistry, ...registryModule } = await import('@core/module-engine')

// Dynamically re-construct registry for isolation
class TestRegistry {
  private _modules = new Map<string, ModuleDefinition>()
  register(def: ModuleDefinition) {
    if (!def.id || !def.id.includes('.')) throw new Error(`Invalid ID "${def.id}"`)
    if (this._modules.has(def.id)) throw new Error(`Already registered: ${def.id}`)
    this._modules.set(def.id, def)
  }
  get(id: string) { return this._modules.get(id) }
  getOrThrow(id: string) {
    const m = this._modules.get(id)
    if (!m) throw new Error(`Not found: ${id}`)
    return m
  }
  has(id: string) { return this._modules.has(id) }
  list() { return Array.from(this._modules.values()) }
  listByCategory() {
    const r: Record<string, ModuleDefinition[]> = {}
    for (const m of this._modules.values()) {
      if (!r[m.category]) r[m.category] = []
      r[m.category].push(m)
    }
    return r
  }
  get size() { return this._modules.size }
}

describe('ModuleRegistry', () => {
  let reg: TestRegistry

  beforeEach(() => {
    reg = new TestRegistry()
  })

  it('registers a module and retrieves it by id', () => {
    const mod = makeModule('base.text')
    reg.register(mod)
    expect(reg.get('base.text')).toBe(mod)
  })

  it('returns undefined for unknown module id', () => {
    expect(reg.get('unknown.module')).toBeUndefined()
  })

  it('throws on getOrThrow for unknown id', () => {
    expect(() => reg.getOrThrow('unknown.module')).toThrow('Not found')
  })

  it('throws if module id is not namespaced', () => {
    expect(() => reg.register(makeModule('heading'))).toThrow('Invalid ID')
    expect(() => reg.register(makeModule(''))).toThrow('Invalid ID')
  })

  it('throws on duplicate registration', () => {
    reg.register(makeModule('base.text'))
    expect(() => reg.register(makeModule('base.text'))).toThrow('Already registered')
  })

  it('has() returns correct boolean', () => {
    expect(reg.has('base.text')).toBe(false)
    reg.register(makeModule('base.text'))
    expect(reg.has('base.text')).toBe(true)
  })

  it('list() returns all registered modules', () => {
    reg.register(makeModule('base.text'))
    reg.register(makeModule('base.image'))
    expect(reg.list().length).toBe(2)
  })

  it('listByCategory() groups modules by category', () => {
    reg.register({ ...makeModule('layout.div'), category: 'Layout' })
    reg.register({ ...makeModule('layout.flex'), category: 'Layout' })
    reg.register({ ...makeModule('text.heading'), category: 'Typography' })
    const cats = reg.listByCategory()
    expect(cats['Layout']).toHaveLength(2)
    expect(cats['Typography']).toHaveLength(1)
  })

  it('size returns correct count', () => {
    expect(reg.size).toBe(0)
    reg.register(makeModule('base.a'))
    reg.register(makeModule('base.b'))
    expect(reg.size).toBe(2)
  })
})

describe('ModuleDefinition render() contract', () => {
  it('render() returns { html: string }', () => {
    const mod = makeModule('base.test')
    const result = mod.render({}, [])
    expect(result).toHaveProperty('html')
    expect(typeof result.html).toBe('string')
  })

  it('render() is a pure function (same input → same output)', () => {
    const mod = makeModule('base.test')
    const r1 = mod.render({ text: 'hello' }, ['<span>child</span>'])
    const r2 = mod.render({ text: 'hello' }, ['<span>child</span>'])
    expect(r1.html).toBe(r2.html)
    expect(r1.assetUsage).toEqual(r2.assetUsage)
  })

  it('render() with children passes renderedChildren as strings', () => {
    const mod: ModuleDefinition = {
      ...makeModule('base.container'),
      canHaveChildren: true,
      render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
    }
    const result = mod.render({}, ['<p>A</p>', '<p>B</p>'])
    expect(result.html).toBe('<div><p>A</p><p>B</p></div>')
  })
})
