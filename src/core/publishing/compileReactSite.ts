import type { Project } from '../page-tree/types'
import type { IModuleRegistry } from '../module-engine/types'
import { pageToComponent } from '../react-publisher/pageToComponent'
import { generateScaffold } from '../react-publisher/scaffold'
import { topoSortVCs, vcToComponent } from '../react-publisher/vcToComponent'
import type { PublishBundle, PublishFile, PublishMode } from './types'

function textFile(path: string, data: string): PublishFile {
  return { path, data, encoding: 'utf8' }
}

function addConvexProvider(mainTsx: string): string {
  return mainTsx
    .replace(
      `import App from './App'`,
      `import App from './App'\nimport { ConvexProvider, ConvexReactClient } from 'convex/react'`,
    )
    .replace(
      `<React.StrictMode>\n    <App />\n  </React.StrictMode>`,
      `<React.StrictMode>\n    <ConvexProvider client={new ConvexReactClient(import.meta.env.VITE_CONVEX_URL)}>\n      <App />\n    </ConvexProvider>\n  </React.StrictMode>`,
    )
}

function withConvexDependency(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  parsed.dependencies = {
    ...(parsed.dependencies ?? {}),
    convex: '^1.34.1',
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function compileReactSite(
  project: Project,
  registry: IModuleRegistry,
  mode: PublishMode,
): PublishBundle {
  const pageComponents = project.pages.map((page) => pageToComponent(page, project, registry))
  const scaffold = generateScaffold(
    project.name,
    pageComponents.map((page) => ({ slug: page.slug, componentName: page.componentName })),
    project.packageJson,
  )

  if (mode === 'managed-convex') {
    scaffold['package.json'] = withConvexDependency(scaffold['package.json'])
    scaffold['src/main.tsx'] = addConvexProvider(scaffold['src/main.tsx'])
  }

  const files: PublishFile[] = Object.entries(scaffold).map(([path, data]) => textFile(path, data))
  for (const page of pageComponents) {
    files.push(textFile(`src/pages/${page.componentName}.tsx`, page.source))
  }

  const userFilePaths = new Set(project.files.filter((file) => !file.generated || file.ejected).map((file) => file.path))
  for (const vc of topoSortVCs(project.visualComponents ?? [])) {
    if (vc.generated && !vc.ejected) continue
    try {
      const component = vcToComponent(vc, project, registry)
      if (!userFilePaths.has(component.filePath)) {
        files.push(textFile(component.filePath, component.source))
      }
    } catch {
      // Visual component codegen is best-effort in this MVP. The editor keeps
      // the source tree; publish diagnostics can be made stricter later.
    }
  }

  for (const file of project.files) {
    if (file.generated && !file.ejected) continue
    if (file.type === 'asset' && file.blob?.base64) {
      files.push({ path: file.path, data: file.blob.base64, encoding: 'base64' })
    }
    if (file.type === 'style' || file.type === 'doc') {
      files.push(textFile(file.path, file.content ?? ''))
    }
  }

  return {
    mode,
    files,
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
    requiredEnv: mode === 'managed-convex' ? ['VITE_CONVEX_URL'] : [],
  }
}

