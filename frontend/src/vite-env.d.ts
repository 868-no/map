/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" compiles in the window.__meshmap end-to-end test hook. */
  readonly VITE_E2E_HOOKS?: string
  readonly VITE_SOURCE_URL?: string
  readonly VITE_SOURCE_REVISION?: string
}
