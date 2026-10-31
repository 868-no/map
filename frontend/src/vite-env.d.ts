/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" compiles in the window.__meshmap end-to-end test hook. */
  readonly VITE_E2E_HOOKS?: string
}
