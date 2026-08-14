import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the real PicGo class. It reproduces the two behaviors this
 * plugin exists to contain: an upload that resolves with an incomplete output
 * array instead of throwing, and a `failed` event that carries the real error.
 */
class FakePicGo extends EventEmitter {
  config: Record<string, unknown> = {}
  cloud: {
    getUserInfo: () => Promise<{ user: string | null } | null>
    login: (token?: string) => Promise<void>
    logout: () => void
    disposeLoginFlow: () => void
  }

  constructor(private readonly behavior: {
    output?: unknown
    throws?: Error
    emitFailure?: Error
    delayMs?: number
    userInfo?: { user: string | null } | null
    userInfoThrows?: Error
  }) {
    super()
    this.cloud = {
      getUserInfo: async () => {
        if (behavior.userInfoThrows !== undefined) throw behavior.userInfoThrows
        return behavior.userInfo ?? null
      },
      login: async () => {},
      logout: () => { delete this.config['settings.picgoCloud.token'] },
      disposeLoginFlow: () => {},
    }
  }

  setConfig(patch: Record<string, unknown>) { Object.assign(this.config, patch) }
  getConfig(key: string) { return (this.config as Record<string, unknown>)[key] }

  async upload(_input?: string[]) {
    if (this.behavior.delayMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, this.behavior.delayMs))
    }
    if (this.behavior.emitFailure !== undefined) {
      this.emit('failed', this.behavior.emitFailure)
    }
    if (this.behavior.throws !== undefined) throw this.behavior.throws
    return this.behavior.output
  }
}

async function loadRunner(behavior: ConstructorParameters<typeof FakePicGo>[0]) {
  vi.resetModules()
  vi.doMock('picgo', () => ({
    PicGo: class { constructor() { return new FakePicGo(behavior) as never } },
    IBuildInEvent: { FAILED: 'failed' },
  }))
  const { PicGoRunner, PicGoUploadError } = await import('../picgo.ts')
  return { PicGoRunner, PicGoUploadError }
}

const signal = () => new AbortController().signal

describe('PicGoRunner', () => {
  it('turns a silent failure into a rejection', async () => {
    // PicGo resolves with an empty output when an upload fails and `debug` is
    // off; treating that as success is the failure mode this guards.
    const { PicGoRunner, PicGoUploadError } = await loadRunner({
      output: [],
      emitFailure: new Error('Storage quota exceeded for plan free'),
    })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    await expect(runner.uploadFiles(['/tmp/a.png'], signal()))
      .rejects.toThrow(PicGoUploadError)
    await expect(runner.uploadFiles(['/tmp/a.png'], signal()))
      .rejects.toThrow(/Storage quota exceeded/u)
  })

  it('surfaces the event error when the rejection itself is uninformative', async () => {
    const { PicGoRunner } = await loadRunner({
      throws: new Error(''),
      emitFailure: new Error('PICGO_CLOUD_UPLOAD_LOGIN_REQUIRED'),
    })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    await expect(runner.uploadFiles(['/tmp/a.png'], signal()))
      .rejects.toThrow(/LOGIN_REQUIRED/u)
  })

  it('identifies failures by position, not by count', async () => {
    // Uploaders fill imgUrl in place on a transformer-built array, so a failed
    // item stays at its original index.
    const { PicGoRunner } = await loadRunner({
      output: [
        { imgUrl: 'https://cdn.test/a.png' },
        { fileName: 'b.png' },
        { imgUrl: 'https://cdn.test/c.png' },
      ],
    })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    const outcome = await runner.uploadFiles(['/a.png', '/b.png', '/c.png'], signal())
    expect(outcome.uploaded).toHaveLength(2)
    expect(outcome.failed).toEqual(['/b.png'])
  })

  it('treats an entry without a URL as a failure', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ fileName: 'a.png', imgUrl: '' }] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    await expect(runner.uploadFiles(['/a.png'], signal())).rejects.toThrow(/upload failed/u)
  })

  it('carries through the fields a caller reads', async () => {
    const { PicGoRunner } = await loadRunner({
      output: [{ imgUrl: 'https://cdn.test/a.png', fileName: 'a.png', type: 'github', size: 42, width: 8, height: 9 }],
    })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    const outcome = await runner.uploadFiles(['/a.png'], signal())
    expect(outcome.uploaded[0]).toEqual({
      imgUrl: 'https://cdn.test/a.png',
      fileName: 'a.png',
      type: 'github',
      size: 42,
      width: 8,
      height: 9,
    })
    expect(outcome.failed).toEqual([])
  })

  it('refuses an empty file list so it cannot become a clipboard upload', async () => {
    const { PicGoRunner } = await loadRunner({ output: [] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    await expect(runner.uploadFiles([], signal())).rejects.toThrow(/No files to upload/u)
  })

  it('stops waiting when the caller cancels', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ imgUrl: 'https://x' }], delayMs: 5000 })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 60_000 })

    const controller = new AbortController()
    const pending = runner.uploadFiles(['/a.png'], controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/u)
  })

  it('gives up on its own deadline', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ imgUrl: 'https://x' }], delayMs: 5000 })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 20 })

    await expect(runner.uploadFiles(['/a.png'], signal())).rejects.toThrow(/timed out/u)
  })

  it('rejects immediately when handed an already-aborted signal', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ imgUrl: 'https://x' }] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    await expect(runner.uploadFiles(['/a.png'], AbortSignal.abort())).rejects.toThrow()
  })

  it('configures PicGo in memory only', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ imgUrl: 'https://x' }] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })

    // debug:true is what makes a failed upload throw instead of resolving empty.
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    expect(picgo.config).toMatchObject({ debug: true, silent: true })
  })

  it('reads no session as logged-out without calling the service', async () => {
    let called = false
    const { PicGoRunner } = await loadRunner({ output: [] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    picgo.cloud.getUserInfo = async () => { called = true; return null }

    expect(await runner.cloudAuth()).toEqual({ kind: 'logged-out' })
    expect(called).toBe(false)
  })

  it('reads a stored-but-rejected token as expired', async () => {
    const { PicGoRunner } = await loadRunner({ output: [], userInfo: null })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    picgo.config['settings.picgoCloud.token'] = 'stale-token'

    expect(await runner.cloudAuth()).toEqual({ kind: 'expired' })
  })

  it('reads a valid token as logged-in and carries the account name', async () => {
    const { PicGoRunner } = await loadRunner({ output: [], userInfo: { user: 'ada@example.com' } })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    picgo.config['settings.picgoCloud.token'] = 'good-token'

    expect(await runner.cloudAuth()).toEqual({ kind: 'logged-in', user: 'ada@example.com' })
  })

  it('reports a failed check as unknown rather than logged-out', async () => {
    // Treating a network error as a logout would push the user through a
    // sign-in they do not need.
    const { PicGoRunner } = await loadRunner({ output: [], userInfoThrows: new Error('ETIMEDOUT') })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    picgo.config['settings.picgoCloud.token'] = 'good-token'

    expect(await runner.cloudAuth()).toEqual({ kind: 'unknown', reason: 'ETIMEDOUT' })
  })

  it('treats a whitespace-only token as no token', async () => {
    const { PicGoRunner } = await loadRunner({ output: [] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo
    picgo.config['settings.picgoCloud.token'] = '   '

    expect(await runner.cloudAuth()).toEqual({ kind: 'logged-out' })
  })

  it('knows which hosts need a sign-in', async () => {
    const { PicGoRunner } = await loadRunner({ output: [] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo

    expect(runner.usesCloud()).toBe(true)  // picgo-cloud is the default
    picgo.config['picBed.uploader'] = 'github'
    expect(runner.usesCloud()).toBe(false)
  })

  it('reports the uploader that handled the batch', async () => {
    const { PicGoRunner } = await loadRunner({ output: [{ imgUrl: 'https://x' }] })
    const runner = new PicGoRunner({ silent: true, timeoutMs: 5000 })
    const picgo = (runner as unknown as { picgo: FakePicGo }).picgo

    expect(runner.currentUploader()).toBe('picgo-cloud')
    picgo.config['picBed.uploader'] = 'github'
    expect(runner.currentUploader()).toBe('github')
  })
})
