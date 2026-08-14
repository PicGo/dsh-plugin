import { describe, expect, it } from 'vitest'
import { createUploadCommand, splitPaths } from '../command.ts'
import { PicGoUploadError, type PicGoRunner, type UploadOutcome } from '../picgo.ts'

function stubRunner(overrides: Partial<PicGoRunner> = {}): PicGoRunner {
  return {
    currentUploader: () => 'smms',
    usesCloud: () => false,
    cloudAuth: async () => ({ kind: 'logged-in' as const }),
    cloudLogin: async () => {},
    cloudLogout: () => {},
    disposeLogin: () => {},
    uploadFiles: async (paths: string[]): Promise<UploadOutcome> => ({
      uploaded: paths.map(() => ({ imgUrl: 'https://cdn.test/x.png' })),
      failed: [],
    }),
    uploadClipboard: async (): Promise<UploadOutcome> => ({
      uploaded: [{ imgUrl: 'https://cdn.test/clip.png' }],
      failed: [],
    }),
    ...overrides,
  } as PicGoRunner
}

function invocation(rawInput: string) {
  return { rawInput, signal: new AbortController().signal } as never
}

describe('splitPaths', () => {
  it('splits on whitespace', () => {
    expect(splitPaths(' /a.png  /b.png ')).toEqual(['/a.png', '/b.png'])
  })

  it('keeps a quoted path with spaces intact', () => {
    expect(splitPaths('"/tmp/my shot.png" /b.png')).toEqual(['/tmp/my shot.png', '/b.png'])
    expect(splitPaths("'/tmp/my shot.png'")).toEqual(['/tmp/my shot.png'])
  })

  it('returns nothing for blank input', () => {
    expect(splitPaths('')).toEqual([])
    expect(splitPaths('   ')).toEqual([])
  })
})

describe('/picgo', () => {
  it('uploads the clipboard when given no argument', async () => {
    let usedClipboard = false
    const command = createUploadCommand(() => stubRunner({
      uploadClipboard: async () => {
        usedClipboard = true
        return { uploaded: [{ imgUrl: 'https://cdn.test/clip.png' }], failed: [] }
      },
    }))

    const result = await command.handler(invocation(''))
    expect(usedClipboard).toBe(true)
    expect(result).toEqual({ kind: 'success', text: 'https://cdn.test/clip.png' })
  })

  it('uploads the given paths instead of the clipboard when arguments are present', async () => {
    let usedClipboard = false
    const command = createUploadCommand(() => stubRunner({
      uploadClipboard: async () => {
        usedClipboard = true
        return { uploaded: [], failed: [] }
      },
    }))

    await command.handler(invocation('/tmp/a.png'))
    expect(usedClipboard).toBe(false)
  })

  it('returns an error result rather than throwing', async () => {
    const command = createUploadCommand(() => stubRunner({
      uploadFiles: async () => { throw new PicGoUploadError('image not found in clipboard') },
    }))

    const result = await command.handler(invocation('/tmp/a.png'))
    expect(result).toEqual({ kind: 'error', text: 'image not found in clipboard' })
  })

  it('names the failed files on a partial success', async () => {
    const command = createUploadCommand(() => stubRunner({
      uploadFiles: async () => ({
        uploaded: [{ imgUrl: 'https://cdn.test/a.png' }],
        failed: ['/tmp/b.png'],
        error: 'quota exceeded',
      }),
    }))

    const result = await command.handler(invocation('/tmp/a.png /tmp/b.png'))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('/tmp/b.png')
    expect(result.text).toContain('quota exceeded')
  })

  it('registers under a name the command parser accepts', () => {
    const command = createUploadCommand(() => stubRunner())
    expect(command.name).toMatch(/^[a-z][a-z0-9_-]*$/u)
    expect(command.description.length).toBeGreaterThan(0)
  })
})

describe('/picgo sign-in', () => {
  const cloud = (auth: Awaited<ReturnType<PicGoRunner['cloudAuth']>>, extra: Partial<PicGoRunner> = {}) =>
    stubRunner({ currentUploader: () => 'picgo-cloud', usesCloud: () => true, cloudAuth: async () => auth, ...extra })

  it('sends a first-run user to the login instead of failing an upload', async () => {
    const command = createUploadCommand(() => cloud({ kind: 'logged-out' }))
    const result = await command.handler(invocation('/tmp/a.png'))

    expect(result.kind).toBe('error')
    expect(result.text).toContain('/picgo login')
    // The free tier is the reason a first-run user can say yes.
    expect(result.text).toContain('free tier')
  })

  it('distinguishes an expired session from never having signed in', async () => {
    const command = createUploadCommand(() => cloud({ kind: 'expired' }))
    const result = await command.handler(invocation('/tmp/a.png'))

    expect(result.text).toContain('expired')
  })

  it('does not gate uploads when the host needs no sign-in', async () => {
    let uploaded = false
    const command = createUploadCommand(() => stubRunner({
      uploadFiles: async () => {
        uploaded = true
        return { uploaded: [{ imgUrl: 'https://cdn.test/a.png' }], failed: [] }
      },
    }))

    await command.handler(invocation('/tmp/a.png'))
    expect(uploaded).toBe(true)
  })

  it('signs in and names the account', async () => {
    let token: string | undefined = 'unset'
    const command = createUploadCommand(() => cloud(
      { kind: 'logged-in', user: 'ada@example.com' },
      { cloudLogin: async (t?: string) => { token = t } },
    ))

    const result = await command.handler(invocation('login'))
    expect(token).toBeUndefined()  // no token argument starts the browser flow
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('ada@example.com')
  })

  it('passes a supplied token straight through', async () => {
    let token: string | undefined
    const command = createUploadCommand(() => cloud(
      { kind: 'logged-in' },
      { cloudLogin: async (t?: string) => { token = t } },
    ))

    await command.handler(invocation('login tok_abc123'))
    expect(token).toBe('tok_abc123')
  })

  it('explains the token fallback when the browser flow fails', async () => {
    const command = createUploadCommand(() => cloud(
      { kind: 'logged-out' },
      { cloudLogin: async () => { throw new Error('browser did not open') } },
    ))

    const result = await command.handler(invocation('login'))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/picgo login <token>')
  })

  it('abandons an in-flight browser login when the caller cancels', async () => {
    let disposed = false
    const controller = new AbortController()
    const command = createUploadCommand(() => cloud({ kind: 'logged-out' }, {
      disposeLogin: () => { disposed = true },
      cloudLogin: async () => {
        controller.abort()
        throw new Error('cancelled')
      },
    }))

    await command.handler({ rawInput: 'login', signal: controller.signal } as never)
    expect(disposed).toBe(true)
  })

  it('reports the active host and session in status', async () => {
    const signedIn = createUploadCommand(() => cloud({ kind: 'logged-in', user: 'ada' }))
    expect((await signedIn.handler(invocation('status'))).text).toContain('Signed in as ada')

    const out = createUploadCommand(() => cloud({ kind: 'logged-out' }))
    expect((await out.handler(invocation('status'))).text).toContain('/picgo login')

    const other = createUploadCommand(() => stubRunner({ currentUploader: () => 'github' }))
    expect((await other.handler(invocation('status'))).text).toContain('no PicGo Cloud sign-in needed')
  })

  it('does not push a re-login when the check itself failed', async () => {
    // A network error is not a logout; telling the user to sign in again would
    // send them through a flow they do not need.
    const command = createUploadCommand(() => cloud({ kind: 'unknown', reason: 'ETIMEDOUT' }))
    const status = await command.handler(invocation('status'))

    expect(status.text).toContain('network problem')
    expect(status.text).not.toContain('Run "/picgo login"')

    // And it must not block the upload either.
    let uploaded = false
    const uploading = createUploadCommand(() => cloud({ kind: 'unknown', reason: 'ETIMEDOUT' }, {
      uploadFiles: async () => {
        uploaded = true
        return { uploaded: [{ imgUrl: 'https://cdn.test/a.png' }], failed: [] }
      },
    }))
    await uploading.handler(invocation('/tmp/a.png'))
    expect(uploaded).toBe(true)
  })
})
