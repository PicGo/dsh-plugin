import { defineConfig } from 'tsdown'

// Self-contained build: a git install runs `prepare` with no monorepo context,
// so this config must not rely on project references or a type-check pass.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: { emitDtsOnly: false },
  clean: true,
})
