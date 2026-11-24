import { marked } from 'marked'

export function releaseNotes(tag: string, changelog: string, generatedNotes: string): string {
  if (!tag.startsWith('v')) throw new Error(`Expected a version tag, got ${tag}`)

  const tokens = marked.lexer(changelog)
  const prefix = `${tag.slice(1)} - `
  const sections = tokens.filter(token =>
    token.type === 'heading' && token.depth === 2 && token.text.startsWith(prefix)
    && /^\d{4}-\d{2}-\d{2}$/.test(token.text.slice(prefix.length)),
  )
  if (sections.length !== 1) throw new Error(`Expected one dated CHANGELOG.md section for ${tag}`)

  const rest = tokens.slice(tokens.indexOf(sections[0]) + 1)
  const nextHeading = rest.findIndex(token => token.type === 'heading' && token.depth === 2)
  const body = rest.slice(0, nextHeading === -1 ? rest.length : nextHeading).map(token => token.raw).join('').trim()
  if (!body) throw new Error(`Empty CHANGELOG.md section for ${tag}`)

  const footerSections = generatedNotes.split(/^(?=## |\*\*Full Changelog\*\*: )/m)
  const credits = footerSections.find(section => /^## New Contributors[ \t]*\r?\n/.test(section))
  const compare = footerSections.find(section => section.startsWith('**Full Changelog**: '))
  return [body, credits?.trim(), compare?.trim()].filter(Boolean).join('\n\n')
}

if (import.meta.main) {
  const [tag, generatedPath] = Bun.argv.slice(2)
  const changelog = await Bun.file('CHANGELOG.md').text()
  const generated = generatedPath ? await Bun.file(generatedPath).text() : ''
  console.log(releaseNotes(tag, changelog, generated))
}
