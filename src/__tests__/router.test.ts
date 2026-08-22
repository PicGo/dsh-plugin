import { afterEach, describe, expect, it, vi } from 'vitest'
import { PicGoRouter, type RouterOptions } from '../router.ts'
import { GuiUnreachableError } from '../server.ts'
import { PicGoUploadError, type UploadRoute } from '../upload.ts'
import type { PicGoRunner } from '../picgo.ts'

const GUI = {
  host: '127.0.0.1',
  port: 36677,
  secret: '',
  probeTimeoutMs: 1500,
  timeoutMs: 5000,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A stand-in for the in-process route; only its identity matters here. */
function fakeLibrary() {
  const library = {
    kind: 'library' as const,
    describe: () => 'in-process PicGo library',
    currentUploader: () => 'github',
    preflight: async () => ({ kind: 'ok' as const }),
    uploadFiles: vi.fn(async () => ({ uploaded: [{ imgUrl: 'https://lib/a.png' }], failed: [] })),
    uploadClipboard: vi.fn(async () => ({ uploaded: [], failed: [] })),
  }
  const getLibrary = vi.fn(() => library as unknown as PicGoRunner)
  return { library, getLibrary }
}

/** Heartbeat answers `alive`; /upload behaviour is supplied per test. */
function stubFetch(alive: boolean | (() => boolean), upload?: () => Promise<Response>) {
  const heartbeats = { count: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.endsWith('/heartbeat')) {
      heartbeats.count += 1
      const ok = typeof alive === 'function' ? alive() : alive
      if (!ok) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ success: true, result: 'alive' }), { status: 200 })
    }
    if (upload !== undefined) return upload()
    return new Response(JSON.stringify({ success: true, result: ['https://gui/a.png'] }), { status: 200 })
  }))
  return heartbeats
}

const router = (overrides: Partial<RouterOptions> = {}) => {
  const { getLibrary, library } = fakeLibrary()
  const instance = new PicGoRouter({
    mode: 'auto',
    gui: GUI,
    probeTtlMs: 5000,
    getLibrary,
    ...overrides,
  })
  return { instance, getLibrary, library }
}

describe('PicGoRouter.select', () => {
  it('picks the desktop app without ever building the library', async () => {
    stubFetch(true)
    const { instance, getLibrary } = router()

    const choice = await instance.select()
    expect(choice.route.kind).toBe('gui')
    // Constructing PicGoRunner loads the user's third-party uploader plugins;
    // a desktop-app user must never pay that cost.
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('falls to the library when nothing answers', async () => {
    stubFetch(false)
    const { instance } = router()

    const choice = await instance.select()
    expect(choice.route.kind).toBe('library')
    expect(choice.reason).toMatch(/not detected/u)
  })

  it('skips the probe entirely when disabled', async () => {
    const heartbeats = stubFetch(true)
    const { instance } = router({ mode: 'off' })

    const choice = await instance.select()
    expect(choice.route.kind).toBe('library')
    expect(choice.reason).toMatch(/gui\.mode/u)
    expect(heartbeats.count).toBe(0)
  })

  it('refuses to substitute a different host when the app is required', async () => {
    stubFetch(false)
    const { instance, getLibrary } = router({ mode: 'only' })

    await expect(instance.select()).rejects.toThrow(PicGoUploadError)
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('probes once for a batch of selections', async () => {
    const heartbeats = stubFetch(true)
    const { instance } = router()

    await instance.select()
    await instance.select()
    await instance.select()
    expect(heartbeats.count).toBe(1)
  })

  it('caches a negative probe too', async () => {
    const heartbeats = stubFetch(false)
    const { instance } = router()

    await instance.select()
    await instance.select()
    expect(heartbeats.count).toBe(1)
  })

  it('notices an app that started after the cache expired', async () => {
    vi.useFakeTimers()
    let up = false
    const heartbeats = stubFetch(() => up)
    const { instance } = router()

    expect((await instance.select()).route.kind).toBe('library')
    up = true
    vi.advanceTimersByTime(6000)

    expect((await instance.select()).route.kind).toBe('gui')
    expect(heartbeats.count).toBe(2)
  })

  it('bypasses a valid cache when asked for the truth', async () => {
    let up = false
    stubFetch(() => up)
    const { instance } = router()

    expect((await instance.select()).route.kind).toBe('library')
    up = true
    // /picgo status uses this: a user who just launched the app must not read
    // a five-second-old lie.
    expect((await instance.select({ fresh: true })).route.kind).toBe('gui')
  })
})

describe('PicGoRouter.run fallback', () => {
  const unreachable = () => { throw new GuiUnreachableError('ECONNREFUSED') }

  it('re-routes to the library when the app really is gone', async () => {
    let up = true
    stubFetch(() => up)
    const { instance, library } = router()

    const { route } = await instance.run(async (r) => {
      if (r.kind === 'gui') { up = false; unreachable() }
      return r.uploadFiles(['/a.png'], AbortSignal.timeout(1000))
    })

    expect(route.kind).toBe('library')
    expect(library.uploadFiles).toHaveBeenCalledOnce()
  })

  it('does not re-route when the app is still answering', async () => {
    // A transport blip while the app is alive may mean it already accepted the
    // file; retrying elsewhere would upload a second copy.
    stubFetch(true)
    const { instance, library } = router()

    await expect(instance.run(async (r) => {
      if (r.kind === 'gui') unreachable()
      return 'unused'
    })).rejects.toBeInstanceOf(GuiUnreachableError)

    expect(library.uploadFiles).not.toHaveBeenCalled()
  })

  it.each([
    ['a rejected upload (500)', new PicGoUploadError('All uploads failed')],
    ['a missing secret (401)', new PicGoUploadError('Unauthorized — set gui.secret')],
    ['a timeout', new PicGoUploadError('did not answer within 5000ms')],
  ])('never falls back after %s', async (_label, error) => {
    stubFetch(true)
    const { instance, library } = router()

    await expect(instance.run(async (r) => {
      if (r.kind === 'gui') throw error
      return 'unused'
    })).rejects.toThrow(error.message)

    // The guard against uploading to a different host, or twice.
    expect(library.uploadFiles).not.toHaveBeenCalled()
  })

  it('returns the desktop app result untouched on success', async () => {
    stubFetch(true)
    const { instance, library } = router()

    const { result, route } = await instance.run(async r => `ran on ${r.kind}`)
    expect(result).toBe('ran on gui')
    expect(route.kind).toBe('gui')
    expect(library.uploadFiles).not.toHaveBeenCalled()
  })

  it('does not fall back in only mode even when the app vanishes', async () => {
    let up = true
    stubFetch(() => up)
    const { instance, library } = router({ mode: 'only' })

    await expect(instance.run(async (r: UploadRoute) => {
      if (r.kind === 'gui') { up = false; unreachable() }
      return 'unused'
    })).rejects.toBeInstanceOf(GuiUnreachableError)

    expect(library.uploadFiles).not.toHaveBeenCalled()
  })
})
