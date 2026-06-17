/**
 * Architecture Gate — AI tool input schemas are a single source of truth.
 *
 * The site write-tool input schemas (`insertHtml`, `updateNodeProps`,
 * `set_color_tokens`, …) live ONCE in the dependency-free leaf
 * `src/core/ai/toolSchemas.ts` (re-exported from `@core/ai`). They are
 * consumed by BOTH sides of the browser bridge:
 *
 *   - the server tool registry (`server/ai/tools/site/writeTools.ts`) advertises
 *     each schema as the tool's `inputSchema`;
 *   - the browser executor (`src/admin/pages/site/agent/executor.ts`) and token
 *     runners (`tokenRunners.ts`) validate each `toolRequest` payload against it.
 *
 * Before this leaf existed the schemas were declared three times and silently
 * drifted, so a server-side constraint never reached the browser validator.
 * This gate locks the SSOT in two ways:
 *
 *   1. RUNTIME IDENTITY — every registered tool's `inputSchema` is the exact
 *      object exported from `@core/ai`. A re-declared local copy would be a
 *      different reference and fail here.
 *   2. NO RE-DECLARATION — the consumer modules import the schemas and do not
 *      define their own `const xxxSchema = Type.Object(...)` tool-input copies.
 *
 * Type-level drift is additionally caught by the compiler: both consumers use
 * the leaf's `Static` types, so adding a required field breaks both at build.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { siteWriteTools } from '../../../server/ai/tools/site/writeTools'
import {
  InsertHtmlInputSchema,
  GetNodeHtmlInputSchema,
  ReadDocumentInputSchema,
  OpenDocumentInputSchema,
  ReplaceNodeHtmlInputSchema,
  DeleteNodeInputSchema,
  UpdateNodePropsInputSchema,
  MoveNodeInputSchema,
  RenameNodeInputSchema,
  DuplicateNodeInputSchema,
  ApplyCssInputSchema,
  AssignClassInputSchema,
  RemoveClassInputSchema,
  ListCodeAssetsInputSchema,
  ReadCodeAssetInputSchema,
  WriteCodeAssetInputSchema,
  PatchCodeAssetInputSchema,
  InspectCodeRuntimeInputSchema,
  AddPageInputSchema,
  DeletePageInputSchema,
  RenamePageInputSchema,
  DuplicatePageInputSchema,
  SetPageTemplateInputSchema,
  ClearPageTemplateInputSchema,
  SetColorTokensInputSchema,
  SetFontTokensInputSchema,
  SetTypeScaleInputSchema,
  SetSpacingScaleInputSchema,
  RenderSnapshotInputSchema,
} from '@core/ai'

const PROJECT_ROOT = join(import.meta.dir, '../../../')

/** Tool name → the canonical leaf schema the registry MUST reference. */
const EXPECTED_SCHEMA_BY_TOOL = {
  insertHtml: InsertHtmlInputSchema,
  getNodeHtml: GetNodeHtmlInputSchema,
  read_document: ReadDocumentInputSchema,
  open_document: OpenDocumentInputSchema,
  replaceNodeHtml: ReplaceNodeHtmlInputSchema,
  deleteNode: DeleteNodeInputSchema,
  updateNodeProps: UpdateNodePropsInputSchema,
  moveNode: MoveNodeInputSchema,
  renameNode: RenameNodeInputSchema,
  duplicateNode: DuplicateNodeInputSchema,
  applyCss: ApplyCssInputSchema,
  assignClass: AssignClassInputSchema,
  removeClass: RemoveClassInputSchema,
  list_code_assets: ListCodeAssetsInputSchema,
  read_code_asset: ReadCodeAssetInputSchema,
  write_code_asset: WriteCodeAssetInputSchema,
  patch_code_asset: PatchCodeAssetInputSchema,
  inspect_code_runtime: InspectCodeRuntimeInputSchema,
  addPage: AddPageInputSchema,
  deletePage: DeletePageInputSchema,
  renamePage: RenamePageInputSchema,
  duplicatePage: DuplicatePageInputSchema,
  setPageTemplate: SetPageTemplateInputSchema,
  clearPageTemplate: ClearPageTemplateInputSchema,
  set_color_tokens: SetColorTokensInputSchema,
  set_font_tokens: SetFontTokensInputSchema,
  set_type_scale: SetTypeScaleInputSchema,
  set_spacing_scale: SetSpacingScaleInputSchema,
  render_snapshot: RenderSnapshotInputSchema,
} as const

describe('ai-tool-schema SSOT gate', () => {
  it('every registered write tool reuses the exact leaf schema object', () => {
    for (const tool of siteWriteTools) {
      const expected = EXPECTED_SCHEMA_BY_TOOL[tool.name as keyof typeof EXPECTED_SCHEMA_BY_TOOL]
      expect(expected, `no expected schema mapped for tool "${tool.name}"`).toBeDefined()
      // Referential identity: a re-declared duplicate would be a different object.
      expect(tool.inputSchema).toBe(expected)
    }
  })

  it('the SSOT map covers every registered tool (no tool ships an unmapped schema)', () => {
    const registered = siteWriteTools.map((t) => t.name).sort()
    const mapped = Object.keys(EXPECTED_SCHEMA_BY_TOOL).sort()
    expect(registered).toEqual(mapped)
  })

  const CONSUMER_SOURCES = {
    'server/ai/tools/site/writeTools.ts': join(
      PROJECT_ROOT,
      'server/ai/tools/site/writeTools.ts',
    ),
    'src/admin/pages/site/agent/executor.ts': join(
      PROJECT_ROOT,
      'src/admin/pages/site/agent/executor.ts',
    ),
    'src/admin/pages/site/agent/tokenRunners.ts': join(
      PROJECT_ROOT,
      'src/admin/pages/site/agent/tokenRunners.ts',
    ),
  }

  for (const [label, path] of Object.entries(CONSUMER_SOURCES)) {
    it(`${label} imports the schemas from @core/ai (does not redeclare them)`, () => {
      const src = readFileSync(path, 'utf8')
      expect(src).toContain("from '@core/ai'")
      // The retired per-tool local declarations must not reappear. (The executor
      // legitimately COMPOSES render_snapshot via `Type.Composite`, which is not
      // one of these `Type.Object` re-declarations.)
      expect(src).not.toMatch(/const\s+insertHtmlSchema\s*=\s*Type\.Object/)
      expect(src).not.toMatch(/const\s+setColorTokensSchema\s*=\s*Type\.Object/)
      expect(src).not.toMatch(/const\s+InsertHtmlInput\s*=\s*Type\.Object/)
    })
  }
})
