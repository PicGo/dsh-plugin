import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  PicGoUploadError,
  isUploaded,
  toUploadedItem,
  type PreflightResult,
  type UploadOutcome,
  type UploadRoute,
} from './upload.ts'

/**
 * The desktop app could not be reached at all.
 *
 * Distinct from every other failure because it is the *only* one the router may
 * answer by falling back to the in-process library. An HTTP-level failure means
 * the app tried and something about the attempt was wrong — retrying elsewhere
 * would upload to a different image host than the user configured, or upload a
 * second copy of a file the app already accepted.
 */
export class GuiUnreachableError extends Error {
  override name = 'GuiUnreachableError'
}

export interface GuiOptions {
  host: string
  port: number
  /** Server auth secret; empty falls back to $PICGO_SERVER_SECRET, then none. */
  secret: string
  probeTimeoutMs: number
  timeoutMs: number
}

/** One entry of the desktop app's `items` array, before we trust any of it. */
export interface RawItem {
  imgUrl?: unknown
  origin?: unknown
  fileName?: unknown
  type?: unknown
  size?: unknown
  width?: unknown
  height?: unknown
}

interface UploadResponse {
  success?: unknown
  result?: unknown
  items?: unknown
  message?: unknown
}

/**
 * Uploads through a running PicGo desktop app's local HTTP server.
 *
 * Why this exists: the desktop app and the in-process library read *different*
 * config files — the app uses Electron's userData dir (on macOS
 * `~/Library/Application Support/picgo/data.json`) while the library reads
 * `~/.picgo/config.json`. A user who configured their image host in the GUI is
 * unreachable through the library, so this route is the only way to honour the
 * setup they actually curated.
 *
 * Deliberately does not import `picgo`: constructing that class loads the
 * user's third-party uploader plugins, which a GUI user should never pay for.
 */
export class PicGoServerRoute implements UploadRoute {
  readonly kind = 'gui' as const

  private readonly options: GuiOptions
  private readonly secret: string | undefined

  constructor(options: GuiOptions) {
    this.options = options
    this.secret = resolveSecret(options.secret)
  }

  get endpoint(): string {
    return `http://${this.options.host}:${this.options.port}`
  }

  describe(): string {
    return `PicGo desktop app — ${this.endpoint}`
  }

  /**
   * Unknowable before an upload runs. The server exposes no endpoint that
   * reveals which uploader the app is configured for, so anything returned here
   * would be a guess. `UploadOutcome.uploader`, read from the response, is the
   * honest answer and arrives after the fact.
   */
  currentUploader(): string {
    return ''
  }

  /**
   * Always ok — there is nothing to precheck, and prechecking would do harm.
   *
   * The desktop app is its own PicGo installation with its own config, its own
   * credentials and its own PicGo Cloud session, none of which are visible from
   * here. Running the *library's* cloud check would consult the wrong file: a
   * user whose GUI is set to GitHub, but whose untouched ~/.picgo/config.json
   * still defaults to picgo-cloud, would be hard-blocked and told to sign in
   * before an upload that needs no sign-in at all. An app answering the
   * heartbeat was configured by the person running it.
   */
  async preflight(): Promise<PreflightResult> {
    return { kind: 'ok' }
  }

  /** Whether the desktop app is listening. Never sends the secret: `/heartbeat` does not require it. */
  async isAlive(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/heartbeat`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.options.probeTimeoutMs),
      })
      if (!response.ok) return false
      const body = await response.json().catch(() => null) as { success?: unknown; result?: unknown } | null
      return body?.success === true && body.result === 'alive'
    } catch {
      return false
    }
  }

  async uploadFiles(paths: string[], signal: AbortSignal): Promise<UploadOutcome> {
    if (paths.length === 0) {
      // An empty list means "upload the clipboard image" to this server, which
      // would upload something the caller never asked for.
      throw new PicGoUploadError('No files to upload.')
    }
    throwIfCancelled(signal)

    const absolute = paths.map(path => isAbsolute(path) ? path : resolve(path))

    // Checked before any network I/O: the server silently drops an unreadable
    // input from its response, so catching it here yields a precise reason,
    // saves a round trip, and avoids needlessly clobbering the clipboard.
    // Collected by index rather than by completion order, so the reported list
    // follows the caller's input order however the stats interleave.
    const readable = await Promise.all(
      absolute.map(path => stat(path).then(s => s.isFile()).catch(() => false)),
    )
    const toSend = absolute.filter((_path, i) => readable[i] === true)
    const missing = paths.filter((_path, i) => readable[i] !== true)

    if (toSend.length === 0) {
      throw new PicGoUploadError(
        `None of the given paths is a readable file: ${missing.join(', ')}`,
      )
    }

    // Re-checked because statting the inputs above is an await point.
    throwIfCancelled(signal)

    const outcome = await this.post(toSend, JSON.stringify({ list: toSend }), signal)
    if (missing.length === 0) return outcome
    return {
      ...outcome,
      failed: [...outcome.failed, ...missing],
      error: outcome.error ?? `Not a readable file: ${missing.join(', ')}`,
    }
  }

  async uploadClipboard(signal: AbortSignal): Promise<UploadOutcome> {
    // No body at all is how this server is told to use the clipboard image.
    return this.post(['clipboard'], undefined, signal)
  }

  private async post(
    inputs: string[],
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<UploadOutcome> {
    throwIfCancelled(signal)

    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.endpoint}/upload`, {
        method: 'POST',
        headers: {
          ...body !== undefined ? { 'Content-Type': 'application/json' } : {},
          ...this.secret !== undefined ? { Authorization: `Bearer ${this.secret}` } : {},
        },
        ...body !== undefined ? { body } : {},
        // Bounds *our* wait, not the app's work — it may still finish in the
        // background, which is exactly why a timeout must not trigger a retry
        // elsewhere.
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch (e) {
      if (signal.aborted) throw new PicGoUploadError('Upload cancelled.')
      if (timeout.aborted) throw new PicGoUploadError(this.timeoutMessage())
      throw new GuiUnreachableError(
        `Could not reach the PicGo desktop app at ${this.endpoint}: ${messageOf(e)}`,
      )
    }

    if (response.status === 401) {
      throw new PicGoUploadError(
        `The PicGo desktop app at ${this.endpoint} rejected the request (401). `
        + 'Its server has an auth secret set — put it in the plugin\'s `gui.secret` config '
        + 'or the PICGO_SERVER_SECRET environment variable.',
      )
    }

    const payload = await response.json().catch(() => null) as UploadResponse | null

    if (payload === null) {
      throw new PicGoUploadError(
        `The PicGo desktop app at ${this.endpoint} returned an unreadable response (HTTP ${response.status}).`,
      )
    }

    if (!response.ok || payload.success !== true) {
      throw new PicGoUploadError(
        describeGuiError(typeof payload.message === 'string' && payload.message !== ''
          ? payload.message
          : `HTTP ${response.status}`, this.endpoint),
      )
    }

    const items = normalizeItems(payload)
    const ok = items.filter(isUploaded)
    if (ok.length === 0) {
      throw new PicGoUploadError(
        describeGuiError('the app reported success but returned no URLs', this.endpoint),
      )
    }

    const { failed, failedUnknown } = attributeFailures(inputs, items)
    const uploader = ok.map(item => item.type).find(type => typeof type === 'string' && type !== '')

    return {
      uploaded: ok.map(toUploadedItem),
      failed,
      ...failedUnknown > 0 ? { failedUnknown } : {},
      ...typeof uploader === 'string' ? { uploader } : {},
      ...failed.length > 0 || failedUnknown > 0
        ? { error: partialFailureMessage(inputs.length, ok.length, failedUnknown, this.endpoint) }
        : {},
    }
  }

  /**
   * Names the likeliest cause, because "timed out" alone is not actionable and
   * the likeliest cause has a one-time fix.
   */
  private timeoutMessage(): string {
    return `The PicGo desktop app at ${this.endpoint} did not answer within ${this.options.timeoutMs}ms. `
      + 'If "rename before upload" is enabled in its settings, it is waiting on a dialog nobody is going '
      + 'to answer — turn that setting off for agent-driven uploads, or set `gui.mode: "off"` in the '
      + 'plugin config to use the in-process library instead.'
  }
}

/**
 * Match uploaded items back to the inputs that produced them.
 *
 * Position is NOT usable here. PicGo-Core's path transformer ends with
 * `ctx.output = results.filter(item => item)`, so an input it could not read is
 * dropped from the array entirely rather than left as a hole — a batch of
 * [good, bad] comes back as a one-entry array with success:true, and index 0
 * belongs to the *first* input, not the failed one. `items[].origin` carries
 * the untouched input path, so it is the only sound key.
 */
export function attributeFailures(
  inputs: string[],
  items: RawItem[],
): { failed: string[]; failedUnknown: number } {
  const ok = items.filter(isUploaded)

  // All-or-nothing: a half-populated `origin` set would invent phantom failures.
  const attributable = ok.every(item => typeof item.origin === 'string' && item.origin !== '')
  if (!attributable) {
    // Do not guess. Slicing by position is provably wrong here, naming every
    // input overstates, and naming none would render a partial batch as a
    // clean success. A count is the honest answer.
    return { failed: [], failedUnknown: Math.max(0, inputs.length - ok.length) }
  }

  // Counted, not just matched, so a repeated input that uploaded once is
  // reported as one success and one failure rather than two of either.
  const remaining = new Map<string, number>()
  for (const item of ok) {
    const key = resolve(String(item.origin))
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  const failed: string[] = []
  for (const input of inputs) {
    const key = resolve(input)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else failed.push(input)
  }

  return { failed, failedUnknown: 0 }
}

/**
 * Prefer `items`, which carries the full per-file detail. Older desktop apps
 * return only `result` (a URL array), so synthesize minimal entries from it.
 */
function normalizeItems(payload: UploadResponse): RawItem[] {
  if (Array.isArray(payload.items) && payload.items.length > 0) {
    return payload.items as RawItem[]
  }
  if (Array.isArray(payload.result)) {
    return payload.result
      .filter((url): url is string => typeof url === 'string' && url !== '')
      .map(imgUrl => ({ imgUrl }))
  }
  return []
}

function partialFailureMessage(
  total: number,
  succeeded: number,
  failedUnknown: number,
  endpoint: string,
): string {
  if (failedUnknown > 0) {
    return `The PicGo desktop app at ${endpoint} returned ${succeeded} of ${total} URLs but did not report `
      + 'which inputs failed (its version predates the "origin" field). Upload the files one at a time '
      + 'to identify them.'
  }
  return `The PicGo desktop app at ${endpoint} uploaded ${succeeded} of ${total} files.`
}

/**
 * The app's own error text is the only signal available, so pass it through and
 * append routing advice only when it reads like an auth problem.
 */
export function describeGuiError(message: string, endpoint: string): string {
  const base = `PicGo desktop app upload failed (${endpoint}): ${message}`
  if (!/login|unauthor|not signed in|未登录|登录/iu.test(message)) return base

  // `/picgo login` writes the PicGo CLI config, which the desktop app does not
  // read — following that advice here would leave the user exactly where they
  // started.
  return `${base}\nSign in from the PicGo desktop app window itself. "/picgo login" will not help here: `
    + 'it writes the PicGo CLI config, which the desktop app does not read.'
}

/**
 * Resolution order: explicit config, then $PICGO_SERVER_SECRET.
 *
 * Deliberately does not read `settings.server.secret` from the CLI config —
 * that is the wrong file for the desktop app, so a secret found there would be
 * a coincidence at best.
 */
function resolveSecret(configured: string): string | undefined {
  const explicit = configured.trim()
  if (explicit !== '') return explicit

  const fromEnv = process.env.PICGO_SERVER_SECRET?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined
}

/**
 * Raise cancellation as our own error type, so callers see one message however
 * far along the upload got. `signal.throwIfAborted()` would surface a raw
 * DOMException whose text differs from the one the fetch path produces.
 */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PicGoUploadError('Upload cancelled.')
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
