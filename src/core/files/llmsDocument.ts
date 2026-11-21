import type { SiteFile } from './schemas'

/** The public crawler guide lives at this exact path in the archive and site files. */
export const LLMS_DOCUMENT_PATH = 'llms.txt'

export function llmsDocumentContent(files: readonly SiteFile[]): string | undefined {
  return files.find((file) => file.path === LLMS_DOCUMENT_PATH && file.type === 'doc')?.content
}
