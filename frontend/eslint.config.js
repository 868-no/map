// ESLint flat config: TypeScript and React hooks rules for app, tests and e2e.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['src/engine/pkg/**', 'dist', 'e2e/.results', 'src/api/schema.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  { files: ['e2e/**/*.ts', 'bench/**/*.mjs', 'vite.config.ts', 'playwright.config.ts'], languageOptions: { globals: globals.node } },
  { files: ['sw/**/*.js'], languageOptions: { globals: globals.serviceworker } },
  // Plain scripts served next to the pages (theme boot, privacy policy, API docs).
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
)
