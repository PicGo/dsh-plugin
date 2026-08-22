import { describe, expect, it, vi } from 'vitest'
import type { PicGoRunner, UploadOutcome } from '../picgo.ts'
import type { PicGoRouter } from '../router.ts'
import { createUploadTool, toCanonical } from '../tool.ts'
import type { UploadRoute } from '../upload.ts'

/** A runner stub; only the members the tool touches are implemented. */
function stubRunner(overrides: Partial<PicGoRunner> = {}): PicGoRunner {
  const base = {
    kind: 'library' as const,
    describe: () => 'in-process PicGo library',
    currentUploader: () => 'github',
    // Default to a host that needs no sign-in, so tests exercise the upload path.
    usesCloud: () => false,
    cloudAuth: async () => ({ kind: 'logged-in' as const }),
    uploadFiles: async (paths: string[]): Promise<UploadOutcome> => ({
      uploaded: paths.map(path => ({ imgUrl: `https://cdn.test/${path.split('/').pop()}` })),
      failed: [],
    }),
    ...overrides,
  }

  // Derived rather than stubbed flat, so overriding usesCloud/cloudAuth still
  // exercises the real precheck rule instead of passing vacuously.
  return {
    ...base,
    preflight: async () => {
      if (!base.usesCloud()) return { kind: 'ok' as const }
      const auth = await base.cloudAuth()
      return auth.kind === 'logged-out' || auth.kind === 'expired'
        ? { kind: 'sign-in-required' as const, state: auth.kind }
        : { kind: 'ok' as const }
    },
  } as PicGoRunner
}

/** Wrap a route in a router that always selects it and never falls back. */
function stubRouter(route: UploadRoute, library?: PicGoRunner): PicGoRouter {
  return {
    library: () => library ?? (route as PicGoRunner),
    select: async () => ({ route, reason: 'stub' }),
    run: async <T>(work: (r: UploadRoute) => Promise<T>) => ({ result: await work(route), route }),
  } as unknown as PicGoRouter
}

const routerFor = (overrides: Partial<PicGoRunner> = {}) => stubRouter(stubRunner(overrides))

const exec = { signal: new AbortController().signal } as never

describe('picgo_upload', () => {
  it('rejects an empty path list instead of falling through to a clipboard upload', async () => {
    const tool = createUploadTool(() => routerFor())
    // PicGo reads an empty input list as "upload the clipboard", which would
    // upload something the caller never asked for.
    await expect(tool.execute({ paths: [] }, exec)).rejects.toThrow(/at least one file path/u)
    await expect(tool.execute({ paths: ['   '] }, exec)).rejects.toThrow(/at least one file path/u)
  })

  it('resolves relative paths to absolute before handing them to PicGo', async () => {
    let received: string[] = []
    const tool = createUploadTool(() => routerFor({
      uploadFiles: async (paths: string[]) => {
        received = paths
        return { uploaded: [{ imgUrl: 'https://cdn.test/a.png' }], failed: [] }
      },
    }))

    await tool.execute({ paths: ['a.png'] }, exec)
    expect(received[0]?.startsWith('/')).toBe(true)
  })

  it('reports partial failures rather than dropping them', () => {
    const canonical = toCanonical(
      {
        uploaded: [{ imgUrl: 'https://cdn.test/ok.png' }],
        failed: ['/tmp/broken.png'],
        error: 'PicGo upload failed via "github": 422',
      },
      'github',
    )

    expect(canonical.uploaded).toHaveLength(1)
    expect(canonical.failed).toEqual(['/tmp/broken.png'])
    expect(canonical.error).toContain('422')
  })

  it('omits the error field entirely on full success', () => {
    const canonical = toCanonical({ uploaded: [{ imgUrl: 'https://cdn.test/ok.png' }], failed: [] }, 'smms')
    expect('error' in canonical).toBe(false)
    expect(canonical.uploader).toBe('smms')
  })

  it('renders one URL per line and calls out failures', () => {
    const render = (value: Parameters<typeof renderProbe>[0]) => renderProbe(value)
    function renderProbe(value: {
      uploaded: { imgUrl: string }[]
      failed: string[]
      uploader: string
      error?: string
    }) {
      const tool = createUploadTool(() => routerFor())
      return tool.output.render({ paths: [] }, value as never)
    }

    const ok = render({ uploaded: [{ imgUrl: 'https://a' }, { imgUrl: 'https://b' }], failed: [], uploader: 'github' })
    expect(ok[0]).toMatchObject({ type: 'text', text: 'https://a\nhttps://b' })

    const partial = render({
      uploaded: [{ imgUrl: 'https://a' }],
      failed: ['/tmp/b.png'],
      uploader: 'github',
      error: 'boom',
    })
    expect((partial[0] as { text: string }).text).toContain('1 of 2 failed')
    expect((partial[0] as { text: string }).text).toContain('/tmp/b.png')
  })

  it('presents a pending card that is a pure function of its args', () => {
    const tool = createUploadTool(() => routerFor())
    const args = { paths: ['/tmp/shot.png'] }

    const first = tool.presentCall?.(args)
    const second = tool.presentCall?.(args)

    // Presenters re-run on session replay, so identical args must render identically.
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      card: 'generic',
      title: 'Upload shot.png to image host',
      locations: [{ path: '/tmp/shot.png' }],
    })
  })

  it('tells the model to hand the sign-in to the user, not to run it', async () => {
    const tool = createUploadTool(() => routerFor({
      currentUploader: () => 'picgo-cloud',
      usesCloud: () => true,
      cloudAuth: async () => ({ kind: 'logged-out' }),
    }))

    await expect(tool.execute({ paths: ['/tmp/a.png'] }, exec)).rejects.toThrow(/\/picgo login/u)
    // `picgo login` with no token blocks on a browser callback; a model that
    // runs it hangs the session.
    await expect(tool.execute({ paths: ['/tmp/a.png'] }, exec)).rejects.toThrow(/Do NOT run "picgo login" yourself/u)
    await expect(tool.execute({ paths: ['/tmp/a.png'] }, exec)).rejects.toThrow(/free tier/u)
  })

  it('does not check for a session when the host needs none', async () => {
    let checked = false
    const tool = createUploadTool(() => routerFor({
      cloudAuth: async () => {
        checked = true
        return { kind: 'logged-out' }
      },
    }))

    await tool.execute({ paths: ['/tmp/a.png'] }, exec)
    expect(checked).toBe(false)
  })

  it('uploads anyway when the session check is inconclusive', async () => {
    let uploaded = false
    const tool = createUploadTool(() => routerFor({
      usesCloud: () => true,
      cloudAuth: async () => ({ kind: 'unknown', reason: 'ETIMEDOUT' }),
      uploadFiles: async () => {
        uploaded = true
        return { uploaded: [{ imgUrl: 'https://cdn.test/a.png' }], failed: [] }
      },
    }))

    await tool.execute({ paths: ['/tmp/a.png'] }, exec)
    expect(uploaded).toBe(true)
  })

  it('titles a multi-file call by count', () => {
    const tool = createUploadTool(() => routerFor())
    expect(tool.presentCall?.({ paths: ['/a.png', '/b.png'] })).toMatchObject({
      title: 'Upload 2 files to image host',
    })
  })
})

describe('picgo_upload on the desktop-app route', () => {
  /** A GUI route stub: its preflight is unconditionally ok, as the real one is. */
  function stubGui(overrides: Partial<UploadRoute> = {}): UploadRoute {
    return {
      kind: 'gui' as const,
      describe: () => 'PicGo desktop app — http://127.0.0.1:36677',
      currentUploader: () => '',
      preflight: async () => ({ kind: 'ok' as const }),
      uploadFiles: async () => ({
        uploaded: [{ imgUrl: 'https://gui/a.png' }],
        failed: [],
        uploader: 'github',
      }),
      uploadClipboard: async () => ({ uploaded: [], failed: [] }),
      ...overrides,
    }
  }

  it('never consults the CLI config for a sign-in the app does not use', async () => {
    // The regression test for the subtlest bug here: a user whose GUI is set to
    // GitHub, but whose untouched ~/.picgo/config.json still says picgo-cloud,
    // must not be blocked on a sign-in that has nothing to do with the upload.
    const cloudAuth = vi.fn(async () => ({ kind: 'logged-out' as const }))
    const library = stubRunner({ usesCloud: () => true, cloudAuth })
    const tool = createUploadTool(() => stubRouter(stubGui(), library))

    const result = await tool.execute({ paths: ['/tmp/a.png'] }, exec) as { uploaded: unknown[] }
    expect(result.uploaded).toHaveLength(1)
    expect(cloudAuth).not.toHaveBeenCalled()
  })

  it('reports the uploader the app actually used, not a guess', async () => {
    const tool = createUploadTool(() => stubRouter(stubGui()))

    const result = await tool.execute({ paths: ['/tmp/a.png'] }, exec) as { uploader: string }
    // currentUploader() is '' on this route because the app's config cannot be
    // read ahead of time; the response is the only honest source.
    expect(result.uploader).toBe('github')
  })

  it('carries an unattributable failure count through to the caller', async () => {
    const tool = createUploadTool(() => stubRouter(stubGui({
      uploadFiles: async () => ({
        uploaded: [{ imgUrl: 'https://gui/a.png' }],
        failed: [],
        failedUnknown: 2,
        error: 'did not report which inputs failed',
      }),
    })))

    const result = await tool.execute({ paths: ['/a.png', '/b.png', '/c.png'] }, exec) as {
      failedUnknown?: number
    }
    expect(result.failedUnknown).toBe(2)

    // A partial batch must never render as a clean success.
    const text = (tool.output.render({ paths: [] }, result as never)[0] as { text: string }).text
    expect(text).toContain('2 of 3 failed')
  })
})
