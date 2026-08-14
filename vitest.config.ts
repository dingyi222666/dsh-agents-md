import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The plugin repo installs no @deepseek-ai runtime dependencies beyond the
// ones it declares; every @deepseek-ai import in the tested graph is either a
// declared dependency (locale, input-trigger, test helpers) or type-only and
// erased before resolution.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
