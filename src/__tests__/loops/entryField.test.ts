import { describe, expect, it } from 'bun:test'
import { resolveEntryFieldItems } from '@core/loops'

describe('current-entry-field loop items', () => {
  it('keeps primitive array values in authored order', () => {
    const result = resolveEntryFieldItems(['first', 'second'], {
      direction: 'asc',
      limit: 10,
    })

    expect(result.totalItems).toBe(2)
    expect(result.items.map((item) => item.fields.value)).toEqual(['first', 'second'])
    expect(result.items.map((item) => item.fields.index)).toEqual([0, 1])
  })

  it('projects object members while preserving the original value', () => {
    const object = { id: 'shot-1', caption: 'Evening light' }
    const result = resolveEntryFieldItems([object])

    expect(result.items[0]?.id).toBe('shot-1')
    expect(result.items[0]?.fields.caption).toBe('Evening light')
    expect(result.items[0]?.fields.value).toEqual(object)
  })

  it('exposes repeater item cells as the item fields', () => {
    const block = { id: 'block-1', cells: { layout: '2-col', images: ['m1', 'm2'] } }
    const result = resolveEntryFieldItems([block])

    expect(result.items[0]?.id).toBe('block-1')
    expect(result.items[0]?.fields).toMatchObject({
      id: 'block-1',
      layout: '2-col',
      images: ['m1', 'm2'],
      index: 0,
    })
    expect(result.items[0]?.fields.value).toEqual(block)
  })

  it('enriches media ids with renderable media fields', () => {
    const result = resolveEntryFieldItems(['media-1'], {
      mediaByReference: new Map([
        ['media-1', {
          publicPath: '/uploads/portfolio-1.webp',
          mimeType: 'image/webp',
          width: 1600,
          height: 1067,
          altText: 'Portrait in a studio',
        }],
      ]),
    })

    expect(result.items[0]?.fields).toMatchObject({
      id: 'media-1',
      value: '/uploads/portfolio-1.webp',
      src: '/uploads/portfolio-1.webp',
      url: '/uploads/portfolio-1.webp',
      path: '/uploads/portfolio-1.webp',
      altText: 'Portrait in a studio',
      mimeType: 'image/webp',
      width: 1600,
      height: 1067,
    })
  })

  it('returns an empty result for non-array fields', () => {
    expect(resolveEntryFieldItems('not-an-array')).toEqual({
      items: [],
      totalItems: 0,
    })
  })
})
