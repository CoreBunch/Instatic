/**
 * Tests for the server-side loop pre-fetch helper.
 * Uses the dbTestFake harness so tests don't require a real DB.
 */

import { describe, expect, it } from 'bun:test'
import {
  collectLoopNodes,
  prefetchLoopData,
  publishedDataRowToLoopItem,
  readLoopProps,
} from '../../../server/publish/loopPrefetch'
import { renderPublishedSnapshot } from '../../../server/publish/publicRenderer'
import type { DbResult } from '../../../server/db'
import { createFakeDb } from './dbTestFake'
import { makePage, makeSite } from '../publisher/helpers'

// Make sure the built-in sources are registered.
import '@core/loops/sources'

describe('loopPrefetch', () => {
  it('maps published data row authorship into public loop fields', () => {
    const item = publishedDataRowToLoopItem({
      id: 'version_1',
      rowId: 'row_1',
      tableId: 'posts',
      tableSlug: 'posts',
      tableKind: 'postType',
      tableRouteBase: '/posts',
      versionNumber: 1,
      cells: {
        title: 'Published post',
        slug: 'published-post',
        body: 'Body',
        seoTitle: '',
        seoDescription: '',
      },
      slug: 'published-post',
      featuredMediaId: null,
      featuredMediaPath: null,
      authorUserId: 'author_1',
      authorName: 'Author Name',
      authorRoleSlug: 'editor',
      authorRoleName: 'Editor',
      publishedByUserId: 'publisher_1',
      publishedByName: 'Publisher Name',
      publishedByRoleSlug: 'admin',
      publishedByRoleName: 'Admin',
      publishedAt: '2026-05-01T10:02:00.000Z',
      createdAt: '2026-05-01T10:02:00.000Z',
    })

    // Every people key is a LEAF. `author` used to be the reference object,
    // so a template binding it published `{"displayName":…,"roleSlug":…}`
    // straight into the page.
    expect(item.fields).toMatchObject({
      author: 'Author Name',
      authorName: 'Author Name',
      authorRoleName: 'Editor',
      authorRoleSlug: 'editor',
      publishedBy: 'Publisher Name',
      publishedByName: 'Publisher Name',
      publishedByRoleName: 'Admin',
      publishedByRoleSlug: 'admin',
    })
    for (const key of ['author', 'publishedBy']) {
      expect(typeof item.fields[key]).not.toBe('object')
    }
    expect('authorUserId' in item.fields).toBe(false)
    expect('authorId' in item.fields).toBe(false)
    expect('publishedByUserId' in item.fields).toBe(false)
    expect('publishedById' in item.fields).toBe(false)
  })

  it('readLoopProps coerces missing/invalid props into safe defaults', () => {
    const props = readLoopProps({
      id: 'l',
      moduleId: 'base.loop',
      props: {},
      children: [],
      breakpointOverrides: {},
      classIds: [],
    })
    expect(props.sourceId).toBe('')
    expect(props.limit).toBe(10)
    expect(props.offset).toBe(0)
    expect(props.direction).toBe('desc')
    expect(props.pagination).toBe('none')
    expect(props.pageSize).toBe(10)
  })

  it('collectLoopNodes returns every base.loop reachable from the root', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1', 'box'] },
      box: { moduleId: 'base.container', children: ['loop2'] },
      loop1: { moduleId: 'base.loop', children: [] },
      loop2: { moduleId: 'base.loop', children: [] },
    })
    const nodes = collectLoopNodes(page, makeSite())
    expect(nodes.map((n) => n.id).sort()).toEqual(['loop1', 'loop2'])
  })

  it('collectLoopNodes descends into VC definition trees (ISS-022)', () => {
    const vcNode = (id: string, moduleId: string, children: string[] = [], props = {}) =>
      ({ id, moduleId, props, children, breakpointOverrides: {}, classIds: [] })
    const site = makeSite({
      visualComponents: [
        {
          id: 'vc1',
          name: 'VC1',
          params: [],
          tree: {
            rootNodeId: 'v1',
            nodes: {
              v1: vcNode('v1', 'base.container', ['v1loop']),
              v1loop: vcNode('v1loop', 'base.loop'),
            },
          },
        },
      ] as never,
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref'] },
      ref: { moduleId: 'base.visual-component-ref', props: { componentId: 'vc1' }, children: [] },
    })
    expect(collectLoopNodes(page, site).map((n) => n.id)).toContain('v1loop')
  })

  it('returns empty map when the page has no loops', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: {} },
    })
    const db = createFakeDb(async () => ({ rows: [], rowCount: 0 }))
    const result = await prefetchLoopData(page, makeSite(), db)
    expect(result.size).toBe(0)
  })

  it('returns empty data for loops referencing an unregistered source', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', props: { sourceId: 'unknown.source' } },
    })
    const db = createFakeDb(async () => ({ rows: [], rowCount: 0 }))
    const result = await prefetchLoopData(page, makeSite(), db)
    expect(result.size).toBe(1)
    expect(result.get('loop')?.items).toEqual([])
  })

  it('data.rows source returns empty when table has no rows', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        props: {
          sourceId: 'data.rows',
          filters: { tableId: 'posts' },
          orderBy: 'publishedAt',
          direction: 'desc',
          limit: 5,
          offset: 0,
        },
      },
    })
    const db = createFakeDb(async (sql): Promise<DbResult> => {
      if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const result = await prefetchLoopData(page, makeSite(), db)
    expect(result.get('loop')?.items).toEqual([])
    expect(result.get('loop')?.totalItems).toBe(0)
  })

  it('site.pages source loops actual site pages', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        props: {
          sourceId: 'site.pages',
          filters: {},
          orderBy: 'definition',
          direction: 'asc',
          limit: 10,
          offset: 0,
        },
      },
    })
    const site = makeSite({
      pages: [
        { id: 'p1', slug: 'about', title: 'About', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, children: [], breakpointOverrides: {}, classIds: [] } }, rootNodeId: 'r' },
        { id: 'p2', slug: 'contact', title: 'Contact', nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, children: [], breakpointOverrides: {}, classIds: [] } }, rootNodeId: 'r' },
      ],
    })
    const db = createFakeDb(async () => ({ rows: [], rowCount: 0 }))
    const result = await prefetchLoopData(page, site, db)
    const data = result.get('loop')
    expect(data?.totalItems).toBe(2)
    expect(data?.items.map((it) => it.fields.title)).toEqual(['About', 'Contact'])
  })

  // An entry template is one page shared by every row, so the only way its
  // loops can filter per row is to read the row being rendered.
  describe('tokenized cell filters', () => {
    function pageWithFilter(cellValue: string, cellOperator = 'is') {
      return makePage({
        root: { moduleId: 'base.body', children: ['loop'] },
        loop: {
          moduleId: 'base.loop',
          props: {
            sourceId: 'data.rows',
            filters: { tableId: 'terms', cellField: 'course', cellOperator, cellValue },
            orderBy: 'publishedAt',
            direction: 'desc',
            limit: 5,
            offset: 0,
          },
        },
      })
    }

    const entryContext = {
      entryStack: [{ id: 'row_1', fields: { slug: 'time-management', title: 'Time Management' } }],
    }

    it('resolves a filter value against the entry being rendered', async () => {
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      await prefetchLoopData(pageWithFilter('{currentEntry.slug}'), makeSite(), db, undefined, {
        templateContext: entryContext,
      })

      expect(params.some((args) => args.includes('time-management'))).toBe(true)
      expect(params.some((args) => args.includes('{currentEntry.slug}'))).toBe(false)
    })

    it('renders nothing when the token resolves to nothing', async () => {
      // The dangerous case: a blank value reads as "no filter" to
      // parseCellFilter, which would list the whole table on every entry.
      let queried = false
      const db = createFakeDb(async (): Promise<DbResult> => {
        queried = true
        return { rows: [], rowCount: 0 }
      })

      const result = await prefetchLoopData(pageWithFilter('{currentEntry.missing}'), makeSite(), db, undefined, {
        templateContext: entryContext,
      })

      expect(result.get('loop')?.items).toEqual([])
      expect(result.get('loop')?.totalItems).toBe(0)
      expect(queried).toBe(false)
    })

    it('leaves a plain filter value untouched', async () => {
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      await prefetchLoopData(pageWithFilter('Time Management (CZ)'), makeSite(), db)

      expect(params.some((args) => args.includes('Time Management (CZ)'))).toBe(true)
    })

    it('renders nothing when only PART of the value resolved', async () => {
      // "course-{currentEntry.missing}" resolves to "course-" — not blank, so
      // a blankness check waves it through. With `isNot` that matches nearly
      // every row in the table: the exact spill the guard exists to stop.
      let queried = false
      const db = createFakeDb(async (): Promise<DbResult> => {
        queried = true
        return { rows: [], rowCount: 0 }
      })

      const result = await prefetchLoopData(
        pageWithFilter('course-{currentEntry.missing}', 'isNot'),
        makeSite(),
        db,
        undefined,
        { templateContext: entryContext },
      )

      expect(result.get('loop')?.items).toEqual([])
      expect(queried).toBe(false)
    })

    it('renders nothing when every token resolved but the value is blank', async () => {
      // A cell holding only whitespace is not "missing" — the token reports a
      // clean resolve — but `parseCellFilter` trims the value to nothing and
      // reads it as "not configured yet", dropping the condition. Tracking
      // token status alone would let this list the whole table.
      let queried = false
      const db = createFakeDb(async (): Promise<DbResult> => {
        queried = true
        return { rows: [], rowCount: 0 }
      })

      const result = await prefetchLoopData(pageWithFilter('{currentEntry.slug}'), makeSite(), db, undefined, {
        templateContext: { entryStack: [{ id: 'row_1', fields: { slug: '   ' } }] },
      })

      expect(result.get('loop')?.items).toEqual([])
      expect(queried).toBe(false)
    })

    it('renders nothing when an empty |fallback is all that is left', async () => {
      // `{a.b|}` is an author-written empty fallback: it fires, so the token
      // counts as resolved, and the result is still an empty filter value.
      let queried = false
      const db = createFakeDb(async (): Promise<DbResult> => {
        queried = true
        return { rows: [], rowCount: 0 }
      })

      const result = await prefetchLoopData(pageWithFilter('{currentEntry.missing|}'), makeSite(), db, undefined, {
        templateContext: entryContext,
      })

      expect(result.get('loop')?.items).toEqual([])
      expect(queried).toBe(false)
    })

    it('still queries for a blank value when the operator ignores it', async () => {
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      await prefetchLoopData(pageWithFilter('{currentEntry.missing|}', 'isSet'), makeSite(), db, undefined, {
        templateContext: entryContext,
      })

      expect(params.length).toBeGreaterThan(0)
    })

    it('treats a fired |fallback as resolved and queries with it', async () => {
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      await prefetchLoopData(
        pageWithFilter('{currentEntry.missing|all-courses}'),
        makeSite(),
        db,
        undefined,
        { templateContext: entryContext },
      )

      expect(params.some((args) => args.includes('all-courses'))).toBe(true)
    })

    it('still queries when the operator ignores the value', async () => {
      // `isSet` never reads cellValue, so an unresolvable token in it is not a
      // reason to empty a loop filtering on a field the query does look at.
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      await prefetchLoopData(
        pageWithFilter('{currentEntry.missing}', 'isSet'),
        makeSite(),
        db,
        undefined,
        { templateContext: entryContext },
      )

      expect(params.some((args) => args.includes('course'))).toBe(true)
    })

    it('resolves {site.name} on the public render path', async () => {
      // The page and site frames are filled inside `publishPage`, which runs
      // AFTER the loop prefetch — so the public renderer has to build them
      // itself for the prefetch or every `{page.*}` / `{site.*}` filter
      // resolves blank and the loop renders empty.
      const params: unknown[][] = []
      const db = createFakeDb(async (sql, args): Promise<DbResult> => {
        params.push(args ?? [])
        if (sql.includes('from data_tables')) return { rows: [{ kind: 'data', fields_json: [] }], rowCount: 1 }
        if (sql.includes('count(*)')) return { rows: [{ total: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      const page = pageWithFilter('{site.name}')
      const site = makeSite({ name: 'Symphera', pages: [page] })

      await renderPublishedSnapshot(
        { cmsSnapshotVersion: 1, pageRowId: page.id, site },
        { db, url: new URL('http://localhost/index') },
      )

      expect(params.some((args) => args.includes('Symphera'))).toBe(true)
      expect(params.some((args) => args.includes('{site.name}'))).toBe(false)
    })
  })
})
