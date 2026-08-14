import { describe, expect, it } from 'vitest'
import type { PicGoRunner, UploadOutcome } from '../picgo.ts'
import { createUploadTool, toCanonical } from '../tool.ts'

/** A runner stub; only the two members the tool touches are implemented. */
function stubRunner(overrides: Partial<PicGoRunner> = {}): PicGoRunner {
  return {
    currentUploader: () => 'github',
    // Default to a host that needs no sign-in, so tests exercise the upload path.
    usesCloud: () => false,
    cloudAuth: async () => ({ kind: 'logged-in' as const }),
    uploadFiles: async (paths: string[]): Promise<UploadOutcome> => ({
      uploaded: paths.map(path => ({ imgUrl: `https://cdn.test/${path.split('/').pop()}` })),
      failed: [],
    }),
    ...overrides,
  } as PicGoRunner
}

const exec = { signal: new AbortController().signal } as never

describe('picgo_upload', () => {
  it('rejects an empty path list instead of falling through to a clipboard upload', async () => {
    const tool = createUploadTool(() => stubRunner())
    // PicGo reads an empty input list as "upload the clipboard", which would
    // upload something the caller never asked for.
    await expect(tool.execute({ paths: [] }, exec)).rejects.toThrow(/at least one file path/u)
    await expect(tool.execute({ paths: ['   '] }, exec)).rejects.toThrow(/at least one file path/u)
  })

  it('resolves relative paths to absolute before handing them to PicGo', async () => {
    let received: string[] = []
    const tool = createUploadTool(() => stubRunner({
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
      const tool = createUploadTool(() => stubRunner())
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
    const tool = createUploadTool(() => stubRunner())
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
    const tool = createUploadTool(() => stubRunner({
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
    const tool = createUploadTool(() => stubRunner({
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
    const tool = createUploadTool(() => stubRunner({
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
    const tool = createUploadTool(() => stubRunner())
    expect(tool.presentCall?.({ paths: ['/a.png', '/b.png'] })).toMatchObject({
      title: 'Upload 2 files to image host',
    })
  })
})
