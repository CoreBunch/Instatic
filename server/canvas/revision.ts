import { contentHash } from '../branches/contentHash'

export function canvasRevision(branch: string, pageId: string, pageSeq: number | undefined, shellSeq: number) {
  return contentHash([branch, pageId, pageSeq, shellSeq])
}
