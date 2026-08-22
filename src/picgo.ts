import { PicGo, IBuildInEvent } from 'picgo'
import {
  PicGoUploadError,
  isUploaded,
  toUploadedItem,
  type PreflightResult,
  type UploadOutcome,
  type UploadRoute,
} from './upload.ts'

// Re-exported so existing import sites keep working; the definitions moved to
// upload.ts so the desktop-app route can share them without importing `picgo`.
export { PicGoUploadError }
export type { UploadedItem, UploadOutcome, PreflightResult, UploadRoute } from './upload.ts'

/** Where the user stands with PicGo Cloud, when that is the active uploader. */
export type CloudAuthState =
  /** A token is present and the service accepted it. */
  | { kind: 'logged-in'; user?: string }
  /** No token stored — a first-run user who has never signed in. */
  | { kind: 'logged-out' }
  /** A token is stored but the service rejected it. */
  | { kind: 'expired' }
  /** The check itself failed, usually a network problem. Not the same as logged out. */
  | { kind: 'unknown'; reason: string }

export interface PicGoRunnerOptions {
  configPath?: string | undefined
  silent: boolean
  timeoutMs: number
}

/**
 * Owns one long-lived PicGo instance and turns its upload contract into an
 * ordinary promise that rejects on failure.
 *
 * Concurrency is safe on a single instance: `Lifecycle.start()` builds a fresh
 * context per call, so `input`/`output` never cross between concurrent uploads.
 */
export class PicGoRunner implements UploadRoute {
  readonly kind = 'library' as const

  private readonly picgo: PicGo
  private readonly timeoutMs: number
  private readonly configPath: string

  constructor(options: PicGoRunnerOptions) {
    this.timeoutMs = options.timeoutMs
    this.configPath = options.configPath ?? ''
    this.picgo = new PicGo(this.configPath)

    // In-memory only. `saveConfig()`/`removeConfig()` would rewrite the user's
    // ~/.picgo/config.json, which they share with the PicGo desktop app.
    this.picgo.setConfig({
      // Without this, a failed upload resolves with an empty output array
      // instead of throwing, and a caller that only checks for exceptions
      // reports success. See Lifecycle.start()'s catch block.
      debug: true,
      // Suppresses both console output and the picgo.log file write — they
      // share one switch in Logger.handleLog().
      ...options.silent ? { silent: true } : {},
    })
  }

  describe(): string {
    return `in-process PicGo library (${this.configPath === '' ? '~/.picgo/config.json' : this.configPath})`
  }

  /**
   * PicGo Cloud is the only host that needs a sign-in, so it is the only one
   * worth blocking an upload for. A failed *check* is not a sign-out and must
   * not block — see `cloudAuth()`'s `unknown` state.
   */
  async preflight(): Promise<PreflightResult> {
    if (!this.usesCloud()) return { kind: 'ok' }

    const auth = await this.cloudAuth()
    if (auth.kind === 'logged-out' || auth.kind === 'expired') {
      return { kind: 'sign-in-required', state: auth.kind }
    }
    return { kind: 'ok' }
  }

  /** The uploader that will handle the next upload, e.g. `github` or `picgo-cloud`. */
  currentUploader(): string {
    return this.picgo.getConfig<string>('picBed.uploader')
      || this.picgo.getConfig<string>('picBed.current')
      || 'picgo-cloud'
  }

  /** Whether uploads currently go to PicGo Cloud, which is the only host that needs a login. */
  usesCloud(): boolean {
    return this.currentUploader() === 'picgo-cloud'
  }

  /**
   * Check the PicGo Cloud session. Distinguishes "never signed in" from "token
   * rejected" from "could not tell", because only the first two are worth
   * prompting a login for.
   */
  async cloudAuth(): Promise<CloudAuthState> {
    const token = this.picgo.getConfig<string | undefined>('settings.picgoCloud.token')?.trim()
    if (token === undefined || token === '') return { kind: 'logged-out' }

    try {
      const info = await this.picgo.cloud.getUserInfo()
      if (info === null) return { kind: 'expired' }
      return { kind: 'logged-in', ...info.user !== null ? { user: info.user } : {} }
    } catch (e) {
      // A network failure is not a logout; saying so would send the user
      // through a sign-in they do not need.
      return { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Sign in to PicGo Cloud.
   *
   * With a token this is non-interactive. Without one it starts a browser OAuth
   * flow and **blocks until the callback arrives**, so only call it where a
   * human is waiting — never from a tool the model invokes.
   */
  async cloudLogin(token?: string): Promise<void> {
    await this.picgo.cloud.login(token)
  }

  /** Abandon an in-flight browser login so a cancelled command does not leave a server listening. */
  disposeLogin(): void {
    this.picgo.cloud.disposeLoginFlow()
  }

  /** Clear the stored PicGo Cloud token. This writes to the user's PicGo config. */
  cloudLogout(): void {
    this.picgo.cloud.logout()
  }

  /**
   * Upload local files and resolve with their hosted URLs.
   *
   * @param paths - absolute file paths; must be non-empty, since PicGo treats
   *   an empty list as a request to upload the clipboard image.
   * @throws PicGoUploadError when nothing was uploaded.
   */
  async uploadFiles(paths: string[], signal: AbortSignal): Promise<UploadOutcome> {
    if (paths.length === 0) {
      throw new PicGoUploadError('No files to upload.')
    }
    return this.run(paths, paths, signal)
  }

  /**
   * Upload the image currently on the system clipboard. Only works on a machine
   * with a desktop session; headless environments fail with a platform-specific
   * error from the underlying clipboard helper.
   *
   * @throws PicGoUploadError when the clipboard holds no image or cannot be read.
   */
  async uploadClipboard(signal: AbortSignal): Promise<UploadOutcome> {
    return this.run(undefined, ['clipboard'], signal)
  }

  private async run(
    input: string[] | undefined,
    labels: string[],
    signal: AbortSignal,
  ): Promise<UploadOutcome> {
    signal.throwIfAborted()

    // PicGo emits `failed` on the instance before rejecting, and that event
    // carries the original error while the rejection may not. Capture it for
    // the lifetime of this call only.
    let emitted: unknown
    const onFailed = (e: unknown) => { emitted = e }
    this.picgo.once(IBuildInEvent.FAILED, onFailed)

    try {
      const output = await this.withDeadline(
        // `upload()` reads `input === undefined` as "use the clipboard".
        input === undefined ? this.picgo.upload() : this.picgo.upload(input),
        signal,
      )
      const items = Array.isArray(output) ? output : []
      const uploaded = items.filter(isUploaded).map(toUploadedItem)

      if (uploaded.length === 0) {
        throw new PicGoUploadError(describeError(emitted ?? output, this.currentUploader()))
      }

      // A partial success resolves normally, so report exactly which inputs
      // produced no URL rather than silently dropping them. Uploaders fill
      // `imgUrl` in place on a transformer-built array, so position — not
      // count — identifies which input failed.
      const failed = items.flatMap((item, i) => isUploaded(item) ? [] : [labels[i] ?? `item ${i + 1}`])
      return {
        uploaded,
        failed,
        uploader: this.currentUploader(),
        ...failed.length > 0
          ? { error: describeError(emitted, this.currentUploader()) }
          : {},
      }
    } catch (e) {
      if (e instanceof PicGoUploadError) throw e
      throw new PicGoUploadError(describeError(emitted ?? e, this.currentUploader()))
    } finally {
      this.picgo.off(IBuildInEvent.FAILED, onFailed)
    }
  }

  /**
   * Stop waiting on cancellation or timeout. PicGo exposes no cancellation of
   * its own, so the underlying request may still finish in the background —
   * this bounds the caller's wait, not PicGo's work.
   */
  private async withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => { reject(new PicGoUploadError(`Upload timed out after ${this.timeoutMs}ms.`)) },
            this.timeoutMs,
          )
          onAbort = () => { reject(new PicGoUploadError('Upload cancelled.')) }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Turn whatever PicGo surfaced into one actionable sentence. PicGo has no error
 * code vocabulary — a failed cloud upload and a bad GitHub token both arrive as
 * a plain Error — so the uploader name is what makes the message actionable.
 */
function describeError(cause: unknown, uploader: string): string {
  const detail = cause instanceof Error
    ? cause.message
    : typeof cause === 'string' && cause !== ''
      ? cause
      : 'no error detail reported'
  return `PicGo upload failed via "${uploader}": ${detail}`
}
