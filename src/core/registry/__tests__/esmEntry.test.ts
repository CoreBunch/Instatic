import { describe, expect, it } from 'bun:test'
import { cleanPackageDescription } from '../description'
import { packageEntryUrlPath, pickEsmEntry } from '../esmEntry'

describe('pickEsmEntry', () => {
  it('prefers the import condition of exports["."]', () => {
    expect(pickEsmEntry({
      exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
      module: './dist/index.esm.js',
      main: './dist/index.cjs',
    })).toEqual({ path: './dist/index.mjs', source: 'exports' })
  })

  it('reads a conditional map that has no "." key', () => {
    expect(pickEsmEntry({ exports: { import: './esm.js', default: './cjs.js' } }))
      .toEqual({ path: './esm.js', source: 'exports' })
  })

  it('prefers a module field over an exports map that only offers require and default', () => {
    // The runtime serves files as they are: `default` beside `require` is
    // almost always CommonJS, while `module` is ESM by convention. Without a
    // `module` field the `default` condition is still the best available entry.
    expect(pickEsmEntry({ exports: { require: './dist/index.cjs', default: './dist/index.cjs' }, module: './dist/index.mjs' }))
      .toEqual({ path: './dist/index.mjs', source: 'module' })
    expect(pickEsmEntry({ exports: { require: './dist/index.cjs', default: './dist/index.js' } }))
      .toEqual({ path: './dist/index.js', source: 'exports' })
  })

  it('accepts string shorthand and one nested condition level', () => {
    expect(pickEsmEntry({ exports: './build/three.module.js' }))
      .toEqual({ path: './build/three.module.js', source: 'exports' })
    expect(pickEsmEntry({ exports: { '.': { browser: { import: './browser.mjs' }, node: './node.js' } } }))
      .toBeNull()
    expect(pickEsmEntry({ exports: { '.': { import: { default: './deep.mjs' } } } }))
      .toEqual({ path: './deep.mjs', source: 'exports' })
  })

  it('ignores export paths that are not package-relative', () => {
    expect(pickEsmEntry({ exports: { '.': { import: 'dist/index.js' } }, main: 'index.js' }))
      .toEqual({ path: 'index.js', source: 'main' })
  })

  it('falls back to module, then main, then nothing', () => {
    expect(pickEsmEntry({ module: 'dist/esm.js', main: 'dist/cjs.js' })).toEqual({ path: 'dist/esm.js', source: 'module' })
    expect(pickEsmEntry({ main: 'index.js' })).toEqual({ path: 'index.js', source: 'main' })
    expect(pickEsmEntry({ main: '' })).toBeNull()
    expect(pickEsmEntry({})).toBeNull()
  })
})

describe('packageEntryUrlPath', () => {
  it('normalises both manifest path spellings to a leading slash', () => {
    expect(packageEntryUrlPath({ path: './build/x.js', source: 'exports' })).toBe('/build/x.js')
    expect(packageEntryUrlPath({ path: 'build/x.js', source: 'main' })).toBe('/build/x.js')
  })
})

describe('cleanPackageDescription', () => {
  it('flattens markdown links, emphasis and whitespace', () => {
    expect(cleanPackageDescription('View docs [here](https://x.dev).  Works in **every** `browser`'))
      .toBe('View docs here. Works in every browser')
    expect(cleanPackageDescription('_Fast_ and *tiny* (~2kB) helper, ~~old~~ API'))
      .toBe('Fast and tiny (~2kB) helper, old API')
  })

  it('keeps emphasis characters that are part of identifiers', () => {
    expect(cleanPackageDescription('Utilities for snake_case keys, ~/.config aware'))
      .toBe('Utilities for snake_case keys, ~/.config aware')
    expect(cleanPackageDescription('lodash_es and my_lib_v2')).toBe('lodash_es and my_lib_v2')
  })
})
