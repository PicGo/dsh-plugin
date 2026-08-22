import { describe, expect, it } from 'vitest'
import { createUploadCommand, splitPaths } from '../command.ts'
import { PicGoUploadError, type PicGoRunner, type UploadOutcome } from '../picgo.ts'
import type { PicGoRouter } from '../router.ts'
import type { UploadRoute } from '../upload.ts'

function stubRunner(overrides: Partial<PicGoRunner> = {}): PicGoRunner {
  const base = {
    kind: 'library' as const,
    describe: () => 'in-process PicGo library',
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
  }

  // Derived so that overriding usesCloud/cloudAuth still exercises the real
  // precheck rule rather than passing vacuously.
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

/** A router that always selects `route` and never falls back. */
function stubRouter(route: UploadRoute, library?: PicGoRunner): PicGoRouter {
  return {
    library: () => library ?? (route as PicGoRunner),
    select: async () => ({ route, reason: 'stub' }),
    run: async <T>(work: (r: UploadRoute) => Promise<T>) => ({ result: await work(route), route }),
  } as unknown as PicGoRouter
}

const routerFor = (overrides: Partial<PicGoRunner> = {}) => stubRouter(stubRunner(overrides))

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
    const command = createUploadCommand(() => routerFor({
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
    const command = createUploadCommand(() => routerFor({
      uploadClipboard: async () => {
        usedClipboard = true
        return { uploaded: [], failed: [] }
      },
    }))

    await command.handler(invocation('/tmp/a.png'))
    expect(usedClipboard).toBe(false)
  })

  it('returns an error result rather than throwing', async () => {
    const command = createUploadCommand(() => routerFor({
      uploadFiles: async () => { throw new PicGoUploadError('image not found in clipboard') },
    }))

    const result = await command.handler(invocation('/tmp/a.png'))
    expect(result).toEqual({ kind: 'error', text: 'image not found in clipboard' })
  })

  it('names the failed files on a partial success', async () => {
    const command = createUploadCommand(() => routerFor({
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
    const command = createUploadCommand(() => routerFor())
    expect(command.name).toMatch(/^[a-z][a-z0-9_-]*$/u)
    expect(command.description.length).toBeGreaterThan(0)
  })
})

describe('/picgo sign-in', () => {
  const cloud = (auth: Awaited<ReturnType<PicGoRunner['cloudAuth']>>, extra: Partial<PicGoRunner> = {}) =>
    routerFor({ currentUploader: () => 'picgo-cloud', usesCloud: () => true, cloudAuth: async () => auth, ...extra })

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
    const command = createUploadCommand(() => routerFor({
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

    const other = createUploadCommand(() => routerFor({ currentUploader: () => 'github' }))
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

describe('/picgo on the desktop-app route', () => {
  function stubGui(overrides: Partial<UploadRoute> = {}): UploadRoute {
    return {
      kind: 'gui' as const,
      describe: () => 'PicGo desktop app — http://127.0.0.1:36677',
      currentUploader: () => '',
      preflight: async () => ({ kind: 'ok' as const }),
      uploadFiles: async () => ({ uploaded: [{ imgUrl: 'https://gui/a.png' }], failed: [] }),
      uploadClipboard: async () => ({ uploaded: [{ imgUrl: 'https://gui/clip.png' }], failed: [] }),
      ...overrides,
    }
  }

  it('names the app and warns about its side effects in status', async () => {
    const command = createUploadCommand(() => stubRouter(stubGui(), stubRunner()))
    const result = await command.handler(invocation('status'))

    expect(result.text).toContain('PicGo desktop app')
    expect(result.text).toContain('own config')
    // The clipboard clobber is the app's own behavior and cannot be disabled,
    // so it has to be stated rather than hidden.
    expect(result.text).toContain('clipboard')
    // A GUI user needs no PicGo Cloud sign-in and must not be prompted for one.
    expect(result.text).not.toContain('Run "/picgo login"')
  })

  it('warns that a cloud login only applies once the app is closed', async () => {
    const library = stubRunner({
      usesCloud: () => true,
      cloudAuth: async () => ({ kind: 'logged-in', user: 'ada@example.com' }),
    })
    const command = createUploadCommand(() => stubRouter(stubGui(), library))

    const result = await command.handler(invocation('login'))
    expect(result.kind).toBe('success')
    // Without this the user signs in, sees success, uploads, and lands on a
    // different host with no explanation.
    expect(result.text).toContain('only when the app is closed')
  })

  it('still uploads the clipboard with no argument', async () => {
    let usedClipboard = false
    const command = createUploadCommand(() => stubRouter(stubGui({
      uploadClipboard: async () => {
        usedClipboard = true
        return { uploaded: [{ imgUrl: 'https://gui/clip.png' }], failed: [] }
      },
    }), stubRunner()))

    await command.handler(invocation(''))
    expect(usedClipboard).toBe(true)
  })

  it('says how many failed even when the app cannot name them', async () => {
    const command = createUploadCommand(() => stubRouter(stubGui({
      uploadFiles: async () => ({
        uploaded: [{ imgUrl: 'https://gui/a.png' }],
        failed: [],
        failedUnknown: 1,
      }),
    }), stubRunner()))

    const result = await command.handler(invocation('/a.png /b.png'))
    expect(result.text).toContain('1 file(s) failed')
  })

  it('reports the library route plainly when no app is running', async () => {
    const command = createUploadCommand(() => routerFor())
    const result = await command.handler(invocation('status'))

    expect(result.text).toContain('in-process PicGo library')
    expect(result.text).toContain('smms')
  })
})
