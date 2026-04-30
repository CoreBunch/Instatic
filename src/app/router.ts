import { createElement, lazy, Suspense } from 'react'
import type { ReactElement } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLoadingScreen } from './AppLoadingScreen'

const Dashboard = lazy(() => import('./Dashboard'))
const ProjectBuilderLayout = lazy(() => import('./ProjectBuilderLayout'))
const EditorLayout = lazy(() => import('./EditorLayout'))
const DatabaseWorkspace = lazy(() => import('./workspaces/DatabaseWorkspace/DatabaseWorkspace'))
const ResourceWorkspace = lazy(() => import('./workspaces/ResourceWorkspace/ResourceWorkspace'))
const PublishWorkspace = lazy(() => import('./workspaces/PublishWorkspace/PublishWorkspace'))

function withSuspense(element: ReactElement) {
  return createElement(
    Suspense,
    { fallback: createElement(AppLoadingScreen) },
    element,
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: withSuspense(createElement(Dashboard)),
  },
  {
    path: '/projects/:projectId',
    element: withSuspense(createElement(ProjectBuilderLayout)),
    children: [
      {
        index: true,
        element: createElement(Navigate, { to: 'editor', replace: true }),
      },
      {
        path: 'editor',
        element: withSuspense(createElement(EditorLayout)),
      },
      {
        path: 'database',
        element: withSuspense(createElement(DatabaseWorkspace)),
      },
      {
        path: 'resources/:tableSlug',
        element: withSuspense(createElement(ResourceWorkspace)),
      },
      {
        path: 'publish',
        element: withSuspense(createElement(PublishWorkspace)),
      },
    ],
  },
])
