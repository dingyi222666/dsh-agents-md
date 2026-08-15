/**
 * Standalone tsdown config for the dsh-agents-md external plugin — the
 * browser-half counterpart of the in-repo clientBundle preset, kept
 * self-contained so this package builds outside the dsh workspace.
 *
 * Emits three artifacts:
 *  - lib/index.js + lib/invariant.js: the Node half (ESM) the host Loader
 *    mounts. Harness packages and cordis stay external — the profile's hoisted
 *    store answers them, so the plugin registers against the SAME registries
 *    the host mounted (a bundled copy would be a second, dead registry).
 *    `yaml` is the plugin's own dependency and ships bundled.
 *  - lib/client.js: the browser half (CJS closure bundle) served by the
 *    modules node half into window.__DSH_BOOT__ — a lazy module-table entry
 *    whose runtime imports are only the shell-seeded platform modules (the
 *    '@' source is pure logic; every @deepseek-ai import is type-only and
 *    erased before bundling).
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dingyi222666/dsh-agents-md'

/** The browser platform seed modules the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * Documented exemption carried over from the repo preset: the snapshot-store
 * engine lives in runtime pending its promotion-time rehoming, and client
 * bundles that touch it must stay external to it.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

const EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

export default [
  {
    name: `${PLUGIN_ID}/node`,
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: (id: string) => id === 'cordis' || id.startsWith('@deepseek-ai/'),
    // `yaml` is the plugin's own dependency and ships bundled so the node half
    // never depends on the profile's hoisted store resolving it.
    deps: { alwaysBundle: ['yaml'] },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
