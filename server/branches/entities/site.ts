/**
 * The site shell as a branch entity: name and settings, minus identity,
 * timestamps, and files (files are entities of their own).
 */
import { SITE_SHELL_LOGICAL_ID, physicalId } from '@core/branches'
import { siteDocId } from '@core/collab'
import type { SiteShell } from '@core/page-tree'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { parseContent } from '../contentHash'
import { fieldChanges } from '../changeDetail'
import type { BranchEntityAdapter, BranchEntityOf } from './adapter'
import { validateMergedShell } from './shell'

const SiteContentSchema = Type.Object({
  name: Type.String(),
  shell: Type.Record(Type.String(), Type.Unknown()),
})
export type SiteContent = Static<typeof SiteContentSchema>
export type SiteEntity = BranchEntityOf<'site', SiteContent>

function siteContent(shell: SiteShell): SiteContent {
  const { id: _id, name, createdAt: _createdAt, updatedAt: _updatedAt, files: _files, ...rest } = shell
  return { name, shell: rest }
}

const SITE_LABELS: Record<string, string> = {
  name: 'Site name',
  settings: 'Settings',
  breakpoints: 'Breakpoints',
  styleRules: 'Style rules',
  conditions: 'Conditions',
  explorer: 'Explorer organization',
  packageJson: 'package.json',
  runtime: 'Runtime',
}

export const siteAdapter: BranchEntityAdapter<'site', SiteContent> = {
  kind: 'site',
  order: () => 0,

  async collect(source): Promise<SiteEntity[]> {
    const shell = await source.shell()
    if (!shell) return []
    return [{
      kind: 'site',
      logicalId: SITE_SHELL_LOGICAL_ID,
      label: 'Site settings',
      tableId: null,
      tableName: null,
      content: siteContent(shell),
    }]
  },

  parse: (value) => parseContent(SiteContentSchema, value, 'site'),

  describe(before, after, conflicts) {
    // Conflict paths arrive as `shell.<field>`; the review names the field.
    const shellConflicts = new Set<string>()
    for (const path of conflicts) {
      shellConflicts.add(path.startsWith('shell.') ? path.slice('shell.'.length) : path)
    }
    return {
      kind: 'site',
      fields: fieldChanges(
        { name: before?.name, ...(before?.shell ?? {}) },
        { name: after?.name, ...(after?.shell ?? {}) },
        { prefix: '', conflicts: shellConflicts, labels: SITE_LABELS },
      ),
    }
  },

  async write(tx, scope, target, content, ctx) {
    // The shell is never deleted by a merge: a null result has nothing to do.
    const current = await getDraftSite(tx, scope)
    if (!current || content === null) return
    const shell = validateMergedShell(target.key, {
      ...current,
      ...content.shell,
      id: current.id,
      name: content.name,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    })
    await saveDraftSite(tx, scope, shell, ctx.actorUserId, { collabInternal: true })
    ctx.notices.shell = true
  },

  async copy(source, to) {
    // One row, copied with a fresh seq.
    if (!(await source.shell())) return
    await source.db`
      insert into site (id, name, settings_json, seq, branch_id)
      select ${physicalId(to.branchId, SITE_SHELL_LOGICAL_ID)}, name, settings_json, 0,
             ${to.branchId}
      from site
      where branch_id = ${source.scope.branchId}
    `
  },

  async remove(tx, branchId) {
    await tx`delete from site where branch_id = ${branchId}`
    await tx`delete from collab_documents where doc_id = ${siteDocId(branchId)}`
  },
}
