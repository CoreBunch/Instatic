import { afterEach, describe, expect, it } from 'bun:test'
import { executeContentTool } from '@content/agent/contentBridge'
import { executeMcpBridgeRequest } from '@admin/ai/useMcpWorkspaceBridge'
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
    let createArgs: Parameters<ContentBridgeHandle['createDocument']>[0] | null = null
    let createCalls = 0
    registerHandle({
      async createDocument(args) {
        createCalls += 1
        createArgs = args
        return 'doc-1'
      },
    })

    const result = await executeContentTool('content_create_document', {
      tableId: 'posts',
      fields: { title: 'Hello' },
      // An unadvertised extra property must not smuggle publication through
      // the create-only capability gate.
      status: 'published',
    })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ documentId: 'doc-1' })
    expect(createCalls).toBe(1)
    expect(createArgs).toEqual({
      tableId: 'posts',
      fields: { title: 'Hello' },
    })
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

  it('forwards the scheduled publish time to the content handle', async () => {
    let statusArgs: Parameters<ContentBridgeHandle['setDocumentStatus']>[0] | null = null
    registerHandle({
      async setDocumentStatus(args) {
        statusArgs = args
      },
    })

    const result = await executeContentTool('content_set_document_status', {
      documentId: 'doc-1',
      status: 'scheduled',
      scheduledAt: '2030-01-02T12:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    expect(statusArgs).toEqual({
      documentId: 'doc-1',
      status: 'scheduled',
      scheduledAt: '2030-01-02T12:00:00.000Z',
    })
  })

  it('forwards active-document navigation to the live content workspace', async () => {
    let selectedDocumentId: string | null = null
    registerHandle({
      async selectDocument(documentId) {
        selectedDocumentId = documentId
        return true
      },
    })

    const result = await executeContentTool('content_set_active_document', {
      documentId: 'article-2',
    })

    expect(result.ok).toBe(true)
    expect(selectedDocumentId).toBe('article-2')
  })

  it('returns a canonical tool error for unknown content tools', async () => {
    registerHandle()

    const result = await executeContentTool('not_a_content_tool', {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown content tool')
  })
})

describe('executeMcpBridgeRequest', () => {
  it('turns a post-mutation save failure into a tool error', async () => {
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: true, data: { changed: true } }),
      'site_apply_css',
      {},
      async () => {
        throw new Error('Draft save failed')
      },
    )

    expect(result).toEqual({ ok: false, error: 'Draft save failed' })
  })

  it('does not persist a failed tool result', async () => {
    let persisted = false
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: false, error: 'Invalid CSS' }),
      'site_apply_css',
      {},
      async () => {
        persisted = true
      },
    )

    expect(result).toEqual({ ok: false, error: 'Invalid CSS' })
    expect(persisted).toBe(false)
  })
})
