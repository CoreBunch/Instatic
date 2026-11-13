import { describe, expect, it } from 'bun:test'
import { insertScaleStep } from '@core/framework'

describe('insertScaleStep', () => {
  it('appends a larger step without moving the base', () => {
    expect(insertScaleStep('xs,s,m,l', 2, '2xl')).toEqual({ steps: 'xs,s,m,l,2xl', baseScaleIndex: 2 })
  })

  it('inserts a smaller step before the base and shifts the base index with it', () => {
    expect(insertScaleStep('s,m,l', 1, '3xs')).toEqual({ steps: '3xs,s,m,l', baseScaleIndex: 2 })
  })

  it('inserts between existing steps at the canonical position', () => {
    expect(insertScaleStep('xs,m,xl', 1, 's')).toEqual({ steps: 'xs,s,m,xl', baseScaleIndex: 2 })
    expect(insertScaleStep('xs,m,xl', 1, 'l')).toEqual({ steps: 'xs,m,l,xl', baseScaleIndex: 1 })
  })

  it('leaves a list that already has the step alone', () => {
    expect(insertScaleStep('xs,s,m', 2, 's')).toEqual({ steps: 'xs,s,m', baseScaleIndex: 2 })
  })

  it('has no answer for a step off the ring, or a list holding one', () => {
    expect(insertScaleStep('xs,s,m', 2, 'huge')).toBeNull()
    expect(insertScaleStep('xs,custom,m', 2, 'l')).toBeNull()
  })
})
