import { describe, expect, it } from 'bun:test'
import { buildFormRuntimeArtifacts } from '../../../scripts/sync-form-runtime'

describe('generated native form runtime', () => {
  it('matches the TypeBox schemas and typed runtime without a browser compiler', async () => {
    for (const artifact of await buildFormRuntimeArtifacts()) {
      expect((await Bun.file(artifact.path).text()).replace(/\r\n/g, '\n'), artifact.path).toBe(artifact.content)
    }
  })
})
