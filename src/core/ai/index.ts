export {
  AiToolOutputSchema,
  aiToolError,
  aiToolOk,
} from './toolOutput'
export type { AiToolImage, AiToolOutput } from './toolOutput'
export {
  AiContentBlockSchema,
} from './contentBlock'
export type { AiContentBlock } from './contentBlock'
export {
  InsertHtmlInputSchema,
  GetNodeHtmlInputSchema,
  AgentDocumentRefSchema,
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
} from './toolSchemas'
export type {
  InsertHtmlInput,
  GetNodeHtmlInput,
  AgentDocumentRef,
  ReadDocumentInput,
  OpenDocumentInput,
  ReplaceNodeHtmlInput,
  DeleteNodeInput,
  UpdateNodePropsInput,
  MoveNodeInput,
  RenameNodeInput,
  DuplicateNodeInput,
  ApplyCssInput,
  AssignClassInput,
  RemoveClassInput,
  ListCodeAssetsInput,
  ReadCodeAssetInput,
  WriteCodeAssetInput,
  PatchCodeAssetInput,
  InspectCodeRuntimeInput,
  AddPageInput,
  DeletePageInput,
  RenamePageInput,
  DuplicatePageInput,
  SetPageTemplateInput,
  ClearPageTemplateInput,
} from './toolSchemas'
export {
  describeAgentDocuments,
  documentRefEquals,
  documentRefForPage,
} from './documentRefs'
export type { AgentDocumentDescriptor } from './documentRefs'
export {
  renderAgentDocument,
} from './readSurface'
export type {
  AgentDocumentRender,
  AgentDocumentInfo,
  AgentDocumentRange,
  AgentDocumentCleanedStrings,
  AgentDocumentRenderOptions,
} from './readSurface'
