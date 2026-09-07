import { describe, expect, it } from 'bun:test'

type ChallengeModule = typeof import('../../../server/forms/challenge')

let importCounter = 0

async function importChallengeWithEnv(env: {
  formSecret?: string
  secretKey?: string
}): Promise<ChallengeModule> {
  const originalFormSecret = process.env.INSTATIC_FORM_SECRET
  const originalSecretKey = process.env.INSTATIC_SECRET_KEY

  if (env.formSecret === undefined) delete process.env.INSTATIC_FORM_SECRET
  else process.env.INSTATIC_FORM_SECRET = env.formSecret

  if (env.secretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
  else process.env.INSTATIC_SECRET_KEY = env.secretKey

  try {
    importCounter += 1
    return await import(`../../../server/forms/challenge.ts?secret-test=${importCounter}`)
  } finally {
    if (originalFormSecret === undefined) delete process.env.INSTATIC_FORM_SECRET
    else process.env.INSTATIC_FORM_SECRET = originalFormSecret

    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
  }
}

describe('public form challenge signing secret configuration', () => {
  it('uses INSTATIC_FORM_SECRET ahead of INSTATIC_SECRET_KEY', async () => {
    const issuer = await importChallengeWithEnv({
      formSecret: 'form-secret',
      secretKey: 'old-master-key',
    })
    const sameFormSecret = await importChallengeWithEnv({
      formSecret: 'form-secret',
      secretKey: 'new-master-key',
    })
    const changedFormSecret = await importChallengeWithEnv({
      formSecret: 'changed-form-secret',
      secretKey: 'old-master-key',
    })

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
    })

    expect(sameFormSecret.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(changedFormSecret.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })

  it('falls back to INSTATIC_SECRET_KEY when no dedicated form secret is configured', async () => {
    const issuer = await importChallengeWithEnv({ secretKey: 'shared-master-key' })
    const verifier = await importChallengeWithEnv({ secretKey: 'shared-master-key' })
    const rotatedMasterKey = await importChallengeWithEnv({ secretKey: 'rotated-master-key' })

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
    })

    expect(verifier.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(rotatedMasterKey.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })

  it('uses a process-local fallback secret when neither env var is configured', async () => {
    const issuer = await importChallengeWithEnv({})
    const secondProcessSecret = await importChallengeWithEnv({})

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
    })

    expect(issuer.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(secondProcessSecret.verifyPublicFormPageToken({
      pageId: 'page-home', localeId: 'fr', publishedVersionId: 'version-fr', pagePath: '/fr/newsletter',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })
})
