/**
 * Live checks against a running PicGo desktop app.
 *
 *   pnpm test:live
 *
 * Named `.mts` so it falls outside vitest's default `*.test.ts` glob: these
 * upload real files to the user's real image host, which must never happen as a
 * side effect of `pnpm test`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PicGoRouter } from '../router.ts'
import { PicGoServerRoute } from '../server.ts'

const GUI = {
  host: '127.0.0.1',
  port: 36677,
  secret: '',
  probeTimeoutMs: 1500,
  timeoutMs: 60_000,
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function fixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-'))
  const path = join(dir, name)
  await writeFile(path, PNG)
  return path
}

describe('live desktop app', () => {
  it('detects the running app', async () => {
    expect(await new PicGoServerRoute(GUI).isAlive()).toBe(true)
  })

  it('uploads a real file and returns a usable URL', async () => {
    const path = await fixture('live-ok.png')
    const outcome = await new PicGoServerRoute(GUI)
      .uploadFiles([path], AbortSignal.timeout(60_000))

    console.log('uploaded:', outcome.uploaded[0]?.imgUrl, 'via', outcome.uploader)
    expect(outcome.uploaded[0]?.imgUrl).toMatch(/^https?:\/\//u)
    expect(outcome.failed).toEqual([])
  })

  it('names the dropped file in a mixed batch', async () => {
    // The behaviour this whole route had to be designed around: the server
    // returns 200/success:true with the failed input missing from `items`.
    const good = await fixture('live-good.png')
    const missing = join(tmpdir(), 'dsh-live-does-not-exist.png')

    const outcome = await new PicGoServerRoute(GUI)
      .uploadFiles([good, missing], AbortSignal.timeout(60_000))

    console.log('mixed batch failed:', outcome.failed)
    expect(outcome.uploaded).toHaveLength(1)
    expect(outcome.failed).toEqual([missing])
  })

  it('routes through the app when it is running', async () => {
    const router = new PicGoRouter({
      mode: 'auto',
      gui: GUI,
      probeTtlMs: 5000,
      getLibrary: () => { throw new Error('library must not be constructed while the app is up') },
    })

    const choice = await router.select({ fresh: true })
    expect(choice.route.kind).toBe('gui')
  })
})
