import { defineConfig } from 'vitest/config'

/**
 * Live checks against a running PicGo desktop app: `pnpm test:live`.
 *
 * Kept in a separate config, and matching a filename the default glob ignores,
 * because these upload real files to the user's real image host — that must
 * never happen as a side effect of `pnpm test`.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/live.e2e.mts'],
    // A real upload over a slow uplink can take far longer than the 5s default.
    testTimeout: 60_000,
  },
})
