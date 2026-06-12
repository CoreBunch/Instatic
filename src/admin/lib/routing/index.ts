/**
 * Tiny in-house router for the admin app. Replaces react-router-dom for the
 * admin shell. Internal admin navigation should use this router; core engine
 * code and published modules must not depend on it.
 *
 * The .tsx/.ts split between Router.tsx and routerHooks.ts is required for
 * React Fast Refresh: mixing component and non-component exports breaks HMR.
 */
export {
  Router,
  MemoryRouter,
  Routes,
  Route,
  Navigate,
  Link,
} from './Router'
export {
  matchPath,
  useLocation,
  useNavigate,
  useParams,
  useInRouterContext,
} from './routerHooks'
