import type { PicGoRunner } from './picgo.ts'
import { GuiUnreachableError, PicGoServerRoute, type GuiOptions } from './server.ts'
import { PicGoUploadError, type UploadRoute } from './upload.ts'

export type GuiMode = 'auto' | 'off' | 'only'

export interface RouterOptions {
  mode: GuiMode
  gui: GuiOptions
  probeTtlMs: number
  /** Lazy on purpose: constructing it loads the user's third-party uploader plugins. */
  getLibrary: () => PicGoRunner
}

export interface RouteChoice {
  route: UploadRoute
  /** Why this route was chosen, for `/picgo status`. */
  reason: string
}

/**
 * Decides which route handles an upload, and is the only place allowed to fall
 * back from one to the other.
 *
 * Callers get a route *handle* rather than asking the router per operation, so
 * that a preflight and the upload it guards always run against the same route.
 * Otherwise a desktop app that dies in between would produce "no sign-in
 * needed" followed by a library upload that needed one.
 */
export class PicGoRouter {
  private readonly options: RouterOptions
  private readonly server: PicGoServerRoute
  private probe: { alive: boolean; at: number } | undefined

  constructor(options: RouterOptions) {
    this.options = options
    this.server = new PicGoServerRoute(options.gui)
  }

  /** The in-process route regardless of probing — `/picgo login` only ever means this one. */
  library(): PicGoRunner {
    return this.options.getLibrary()
  }

  get endpoint(): string {
    return this.server.endpoint
  }

  async select(options: { fresh?: boolean } = {}): Promise<RouteChoice> {
    if (this.options.mode === 'off') {
      return {
        route: this.library(),
        reason: 'desktop-app route disabled by gui.mode: "off"',
      }
    }

    const alive = await this.isAlive(options.fresh === true)

    if (alive) {
      return { route: this.server, reason: 'heartbeat ok' }
    }

    if (this.options.mode === 'only') {
      // The user asked to fail rather than silently upload somewhere else.
      throw new PicGoUploadError(
        `gui.mode is "only" but nothing answered at ${this.server.endpoint}. `
        + 'Start the PicGo desktop app, or set gui.mode to "auto" to allow the in-process library.',
      )
    }

    return {
      route: this.library(),
      reason: `PicGo desktop app not detected at ${this.server.endpoint}`,
    }
  }

  /**
   * Run an upload on the selected route, falling back only when the desktop app
   * turns out to be gone.
   *
   * The fallback is deliberately narrow. An HTTP-level failure means the app
   * tried: retrying on the library would upload to a *different* image host
   * than the user configured, and — if the app had already accepted the file —
   * would upload a second copy. Only a transport failure that a second
   * heartbeat confirms is worth re-routing.
   */
  async run<T>(
    work: (route: UploadRoute) => Promise<T>,
    options: { fresh?: boolean } = {},
  ): Promise<{ result: T; route: UploadRoute }> {
    const choice = await this.select(options)

    try {
      return { result: await work(choice.route), route: choice.route }
    } catch (e) {
      if (choice.route.kind !== 'gui' || !(e instanceof GuiUnreachableError)) throw e
      if (this.options.mode === 'only') throw e

      // A mid-stream reset could also mean the app accepted the file and then
      // died. Confirm it is really gone before risking a duplicate upload.
      this.probe = undefined
      if (await this.server.isAlive()) throw e

      const library = this.library()
      return { result: await work(library), route: library }
    }
  }

  /**
   * Cached because a multi-file command must not probe once per file. Both
   * outcomes are cached: an app that starts mid-session is picked up within the
   * TTL, and an app that stops is caught by the fallback above rather than by
   * waiting for the cache to expire.
   */
  private async isAlive(fresh: boolean): Promise<boolean> {
    const now = Date.now()
    if (!fresh && this.probe !== undefined && now - this.probe.at < this.options.probeTtlMs) {
      return this.probe.alive
    }

    const alive = await this.server.isAlive()
    this.probe = { alive, at: now }
    return alive
  }
}
