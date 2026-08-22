import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PicGoUploadError } from '../upload.ts'
import { GuiUnreachableError, PicGoServerRoute, attributeFailures } from '../server.ts'

const OPTIONS = {
  host: '127.0.0.1',
  port: 36677,
  secret: '',
  probeTimeoutMs: 1500,
  timeoutMs: 5000,
}

/** Real files, because the route stats its inputs before touching the network. */
let dir: string
let fileA: string
let fileB: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-picgo-'))
  fileA = join(dir, 'a.png')
  fileB = join(dir, 'b.png')
  await writeFile(fileA, 'a')
  await writeFile(fileB, 'b')
})

afterEach(() => { vi.unstubAllGlobals() })

/** Respond to /upload with `payload`; /heartbeat always reports alive. */
function stubFetch(payload: unknown, init: { status?: number; raw?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchMock = vi.fn(async (url: string | URL, requestInit?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init: requestInit })
    if (href.endsWith('/heartbeat')) {
      return new Response(JSON.stringify({ success: true, result: 'alive' }), { status: 200 })
    }
    const status = init.status ?? 200
    const body = init.raw ?? JSON.stringify(payload)
    return new Response(body, { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

const signal = () => new AbortController().signal
const route = (overrides: Partial<typeof OPTIONS> = {}) =>
  new PicGoServerRoute({ ...OPTIONS, ...overrides })

describe('attributeFailures', () => {
  it('names the dropped input, not the one that survived', () => {
    // The regression test for this whole route. The server returns HTTP 200
    // with success:true and a SHORTER items array — the failed input is gone,
    // not left as a hole. A position-based implementation passes every other
    // test here and fails this one.
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/missing.png'],
      [{ imgUrl: 'https://cdn/a.png', origin: '/tmp/a.png' }],
    )
    expect(result.failed).toEqual(['/tmp/missing.png'])
    expect(result.failedUnknown).toBe(0)
  })

  it('handles the failure being the first input', () => {
    // Position-based attribution gives exactly the opposite answer here.
    const result = attributeFailures(
      ['/tmp/bad.png', '/tmp/good.png'],
      [{ imgUrl: 'https://cdn/good.png', origin: '/tmp/good.png' }],
    )
    expect(result.failed).toEqual(['/tmp/bad.png'])
  })

  it('counts duplicates rather than matching them', () => {
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/a.png'],
      [{ imgUrl: 'https://cdn/a.png', origin: '/tmp/a.png' }],
    )
    expect(result.failed).toEqual(['/tmp/a.png'])
  })

  it('reports a count when the app is too old to say which failed', () => {
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      [{ imgUrl: 'https://cdn/a.png' }],
    )
    expect(result.failed).toEqual([])
    expect(result.failedUnknown).toBe(2)
  })

  it('falls back to a count when only some items carry origin', () => {
    // A half-populated origin set would otherwise invent phantom failures.
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/b.png'],
      [{ imgUrl: 'https://cdn/a.png', origin: '/tmp/a.png' }, { imgUrl: 'https://cdn/b.png' }],
    )
    expect(result.failed).toEqual([])
    expect(result.failedUnknown).toBe(0)
  })

  it('treats an entry without a URL as a failure', () => {
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/b.png'],
      [{ imgUrl: 'https://cdn/a.png', origin: '/tmp/a.png' }, { imgUrl: '', origin: '/tmp/b.png' }],
    )
    expect(result.failed).toEqual(['/tmp/b.png'])
  })

  it('reports nothing failed on a clean batch', () => {
    const result = attributeFailures(
      ['/tmp/a.png', '/tmp/b.png'],
      [
        { imgUrl: 'https://cdn/a.png', origin: '/tmp/a.png' },
        { imgUrl: 'https://cdn/b.png', origin: '/tmp/b.png' },
      ],
    )
    expect(result.failed).toEqual([])
    expect(result.failedUnknown).toBe(0)
  })
})

describe('PicGoServerRoute', () => {
  it('carries through the fields a caller reads and names the uploader', async () => {
    stubFetch({
      success: true,
      result: ['https://cdn/a.png'],
      items: [{
        imgUrl: 'https://cdn/a.png',
        origin: fileA,
        fileName: 'a.png',
        type: 'github',
        size: 1,
        width: 8,
        height: 9,
      }],
    })

    const outcome = await route().uploadFiles([fileA], signal())
    expect(outcome.uploaded[0]).toEqual({
      imgUrl: 'https://cdn/a.png',
      fileName: 'a.png',
      type: 'github',
      size: 1,
      width: 8,
      height: 9,
    })
    expect(outcome.uploader).toBe('github')
    expect(outcome.failed).toEqual([])
  })

  it('attributes a silently dropped file end to end', async () => {
    stubFetch({
      success: true,
      result: ['https://cdn/a.png'],
      items: [{ imgUrl: 'https://cdn/a.png', origin: fileA, type: 'github' }],
    })

    // fileB exists, so it reaches the server and comes back dropped.
    const outcome = await route().uploadFiles([fileA, fileB], signal())
    expect(outcome.uploaded).toHaveLength(1)
    expect(outcome.failed).toEqual([fileB])
    expect(outcome.error).toMatch(/uploaded 1 of 2/u)
  })

  it('synthesizes items from a result-only response', async () => {
    stubFetch({ success: true, result: ['https://cdn/a.png'] })

    const outcome = await route().uploadFiles([fileA], signal())
    expect(outcome.uploaded).toEqual([{ imgUrl: 'https://cdn/a.png' }])
    expect(outcome.uploader).toBeUndefined()
  })

  it('never sends an empty list, which would upload the clipboard', async () => {
    const { fetchMock } = stubFetch({ success: true, result: [] })

    await expect(route().uploadFiles([], signal())).rejects.toThrow(/No files to upload/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects unreadable paths without touching the network', async () => {
    const { fetchMock } = stubFetch({ success: true, result: [] })

    await expect(route().uploadFiles(['/tmp/definitely-not-here-xyz.png'], signal()))
      .rejects.toThrow(/readable file/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only the readable paths and reports the rest as failed', async () => {
    const missing = join(dir, 'gone.png')
    const { calls } = stubFetch({
      success: true,
      result: ['https://cdn/a.png'],
      items: [{ imgUrl: 'https://cdn/a.png', origin: fileA }],
    })

    const outcome = await route().uploadFiles([fileA, missing], signal())
    const upload = calls.find(call => call.url.endsWith('/upload'))
    expect(JSON.parse(String(upload?.init?.body))).toEqual({ list: [fileA] })
    expect(outcome.failed).toEqual([missing])
    expect(outcome.uploaded).toHaveLength(1)
  })

  it('throws when every upload failed', async () => {
    stubFetch({ success: false, result: [], items: [], message: 'All uploads failed' }, { status: 500 })

    await expect(route().uploadFiles([fileA], signal()))
      .rejects.toThrow(/All uploads failed/u)
  })

  it('points a 401 at the secret settings and does not look unreachable', async () => {
    stubFetch({ success: false, message: 'Unauthorized' }, { status: 401 })

    const error = await route().uploadFiles([fileA], signal()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PicGoUploadError)
    // Must not be GuiUnreachableError, or the router would fall back and upload
    // to a different image host than the user configured.
    expect(error).not.toBeInstanceOf(GuiUnreachableError)
    expect((error as Error).message).toMatch(/gui\.secret|PICGO_SERVER_SECRET/u)
  })

  it('tells the user to sign in inside the app, not via /picgo login', async () => {
    stubFetch({ success: false, message: 'PICGO_CLOUD_UPLOAD_LOGIN_REQUIRED' }, { status: 500 })

    const error = await route().uploadFiles([fileA], signal()).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/desktop app window itself/u)
    expect((error as Error).message).toMatch(/will not help here/u)
  })

  it('throws rather than resolving empty when success is claimed with no URLs', async () => {
    stubFetch({ success: true, result: [], items: [] })

    await expect(route().uploadFiles([fileA], signal()))
      .rejects.toThrow(/returned no URLs/u)
  })

  it('surfaces an unreadable body as an error, not a parse crash', async () => {
    stubFetch(undefined, { status: 200, raw: 'not json' })

    await expect(route().uploadFiles([fileA], signal()))
      .rejects.toThrow(/unreadable response/u)
  })

  it('reports a dead socket as unreachable so the router may fall back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    await expect(route().uploadFiles([fileA], signal()))
      .rejects.toBeInstanceOf(GuiUnreachableError)
  })

  it('names the rename dialog when the app does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })
    }))

    const error = await route({ timeoutMs: 20 }).uploadFiles([fileA], signal())
      .catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/rename before upload/u)
    expect(error).not.toBeInstanceOf(GuiUnreachableError)
  })

  it('distinguishes a caller cancellation from a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })
    }))

    const controller = new AbortController()
    const pending = route({ timeoutMs: 60_000 }).uploadFiles([fileA], controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/u)
  })

  it('sends the secret on upload but never on the heartbeat', async () => {
    const { calls } = stubFetch({
      success: true,
      result: ['https://cdn/a.png'],
      items: [{ imgUrl: 'https://cdn/a.png', origin: fileA }],
    })

    const withSecret = route({ secret: 's3cret' })
    await withSecret.isAlive()
    await withSecret.uploadFiles([fileA], signal())

    const heartbeat = calls.find(call => call.url.endsWith('/heartbeat'))
    const upload = calls.find(call => call.url.endsWith('/upload'))
    expect((heartbeat?.init?.headers as Record<string, string>)?.Authorization).toBeUndefined()
    expect((upload?.init?.headers as Record<string, string>)?.Authorization).toBe('Bearer s3cret')
  })

  it('uploads the clipboard with no body at all', async () => {
    const { calls } = stubFetch({ success: true, result: ['https://cdn/clip.png'] })

    await route().uploadClipboard(signal())
    const upload = calls.find(call => call.url.endsWith('/upload'))
    expect(upload?.init?.body).toBeUndefined()
    expect((upload?.init?.headers as Record<string, string>)?.['Content-Type']).toBeUndefined()
  })

  it('never prechecks a sign-in it cannot see', async () => {
    // The app has its own config and its own session; the library's cloud check
    // would consult the wrong file and could hard-block a needless sign-in.
    expect(await route().preflight()).toEqual({ kind: 'ok' })
  })

  it('refuses to guess the uploader before an upload runs', async () => {
    expect(route().currentUploader()).toBe('')
  })

  it('reads a heartbeat that is not alive as dead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })))
    expect(await route().isAlive()).toBe(false)
  })
})
