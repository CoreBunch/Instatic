import { afterEach, describe, expect, it } from 'bun:test'
import { executeContentTool } from '@content/agent/contentBridge'
import {
  setContentBridgeHandle,
  type ContentBridgeHandle,
} from '@content/agent/contentBridgeHandle'

function registerHandle(overrides: Partial<ContentBridgeHandle> = {}) {
  const calls: string[] = []
  const handle: ContentBridgeHandle = {
    buildSnapshot() {
      return {
        collections: [],
        activeTableId: null,
        activeDocument: null,
        currentUser: {
          id: 'user-1',
          displayName: 'AI',
          email: 'ai@example.test',
        },
      }
    },
    listCollections() {
      return []
    },
    getActiveCollectionId() {
      return null
    },
    getActiveDocument() {
      return null
    },
    findDocument() {
      return null
    },
    async selectDocument() {
      calls.push('selectDocument')
      return true
    },
    async selectCollection() {
      calls.push('selectCollection')
      return true
    },
    async createDocument() {
      calls.push('createDocument')
      return 'doc-1'
    },
    async deleteDocument() {
      calls.push('deleteDocument')
    },
    async setDocumentStatus() {
      calls.push('setDocumentStatus')
    },
    async setDocumentField() {
      calls.push('setDocumentField')
    },
    async setDocumentFields() {
      calls.push('setDocumentFields')
    },
    async setDocumentAuthor() {
      calls.push('setDocumentAuthor')
    },
    ...overrides,
  }
  setContentBridgeHandle(handle)
  return { calls }
}

afterEach(() => {
  setContentBridgeHandle(null)
})

describe('executeContentTool', () => {
  it('returns the new document id in canonical tool data', async () => {
    const { calls } = registerHandle()

    const result = await executeContentTool('content_create_document', {
      tableId: 'posts',
      fields: { title: 'Hello' },
    })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ documentId: 'doc-1' })
    expect(calls).toEqual(['createDocument'])
  })

  it('returns a canonical tool error when scheduledAt is missing', async () => {
    const { calls } = registerHandle()

    const result = await executeContentTool('content_set_document_status', {
      documentId: 'doc-1',
      status: 'scheduled',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('scheduledAt is required')
    expect(calls).toEqual([])
  })

  it('returns a canonical tool error for unknown content tools', async () => {
    registerHandle()

    const result = await executeContentTool('not_a_content_tool', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown content tool')
  })
})
