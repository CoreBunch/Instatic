import { describe, expect, it } from 'bun:test'
import { extendScaleToStep } from '@core/framework'

describe('extendScaleToStep', () => {
  it('appends a larger step without moving the base', () => {
    expect(extendScaleToStep('xs,s,m,l', 2, '2xl')).toEqual({ steps: 'xs,s,m,l,xl,2xl', baseScaleIndex: 2 })
  })

  it('inserts a smaller step before the base and shifts the base index with it', () => {
    expect(extendScaleToStep('s,m,l', 1, '3xs')).toEqual({ steps: '3xs,2xs,xs,s,m,l', baseScaleIndex: 4 })
  })

  it('keeps internal gaps so existing steps keep their size', () => {
    expect(extendScaleToStep('xs,m,xl', 1, 's')).toBeNull()
    expect(extendScaleToStep('xs,m,xl', 1, 'l')).toBeNull()
  })

  it('leaves a list that already has the step alone', () => {
    expect(extendScaleToStep('xs,s,m', 2, 's')).toEqual({ steps: 'xs,s,m', baseScaleIndex: 2 })
  })

  it('has no answer for a step off the ring, or a list holding one', () => {
    expect(extendScaleToStep('xs,s,m', 2, 'huge')).toBeNull()
    expect(extendScaleToStep('xs,custom,m', 2, 'l')).toBeNull()
  })
})
