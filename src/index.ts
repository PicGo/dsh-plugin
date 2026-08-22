import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUploadCommand } from './command.ts'
import { PicGoRunner } from './picgo.ts'
import { PicGoRouter, type GuiMode } from './router.ts'
import { loadPackagedSkill } from './skill.ts'
import { createUploadTool } from './tool.ts'

export const name = 'picgo'

// An object here would be read as a name → intercept-config map, not as
// required/optional groups. All three services ship in @deepseek-ai/dsh-base.
export const inject = ['tools', 'commands', 'skills']

/**
 * How to reach a running PicGo desktop app.
 *
 * The app is a separate PicGo installation reading a different config file
 * (Electron's userData dir, not `~/.picgo/config.json`), so routing through it
 * is the only way to honour an image host configured in the GUI.
 */
export interface GuiConfig {
  /**
   * `auto` uses the app when it answers and the in-process library otherwise;
   * `off` never probes; `only` requires the app rather than silently uploading
   * to a different host.
   */
  mode: GuiMode
  host: string
  port: number
  /** Server auth secret. Empty falls back to $PICGO_SERVER_SECRET, then none. */
  secret: string
  probeTimeoutMs: number
  /** How long a heartbeat result stays good, so a batch does not re-probe per file. */
  probeTtlMs: number
  /** Upload deadline for this route. 0 inherits the top-level `timeoutMs`. */
  timeoutMs: number
}

export interface Config {
  /** PicGo config file. Empty string uses PicGo's own default, `~/.picgo/config.json`. */
  configPath: string
  /** Suppress PicGo's console output and its picgo.log file writes. */
  silent: boolean
  /** How long to wait for one upload before giving up. */
  timeoutMs: number
  /** Register the packaged picgo-upload skill so the model knows when to upload. */
  registerSkill: boolean
  /** Register the `/picgo` human command. */
  registerCommand: boolean
  /**
   * On startup, when PicGo Cloud is the active host and nobody is signed in,
   * log a one-line pointer at `/picgo login`.
   */
  announceSignIn: boolean
  /** Whether and how to route uploads through a running PicGo desktop app. */
  gui: GuiConfig
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string().default(''),
  silent: Schema.boolean().default(true),
  timeoutMs: Schema.number().default(120_000),
  registerSkill: Schema.boolean().default(true),
  registerCommand: Schema.boolean().default(true),
  announceSignIn: Schema.boolean().default(true),
  gui: Schema.object({
    mode: Schema.union(['auto', 'off', 'only']).default('auto'),
    // The literal, not `localhost`: skips a DNS lookup and avoids resolving to
    // ::1 when the app is bound to IPv4 only.
    host: Schema.string().default('127.0.0.1'),
    port: Schema.number().default(36677),
    secret: Schema.string().role('secret').default(''),
    probeTimeoutMs: Schema.number().default(1500),
    probeTtlMs: Schema.number().default(5000),
    timeoutMs: Schema.number().default(0),
  }),
})

/**
 * Point a first-run user at the sign-in. Only speaks up when PicGo Cloud is the
 * active host and there is no usable session — a user with GitHub or S3
 * configured needs no login and should hear nothing.
 */
async function announceSignIn(
  router: PicGoRouter,
  logger: Context['logger'],
  cancelled: () => boolean,
): Promise<void> {
  // A desktop-app user needs no PicGo Cloud login and must not be nagged for
  // one at every startup — the app has its own config and its own session.
  const choice = await router.select()
  if (cancelled() || choice.route.kind !== 'library') return

  const runner = router.library()
  if (!runner.usesCloud()) return

  const auth = await runner.cloudAuth()
  if (cancelled()) return

  if (auth.kind === 'logged-out') {
    logger.info(
      'PicGo Cloud is the active image host but you are not signed in. '
      + 'Run "/picgo login" to sign in — the free tier covers casual use.',
    )
  } else if (auth.kind === 'expired') {
    logger.info('Your PicGo Cloud session expired. Run "/picgo login" to sign in again.')
  }
}

export function apply(ctx: Context, config: Config): void {
  // Constructed lazily: it loads third-party uploader plugins from the user's
  // PicGo home, and a broken plugin there should surface on first use rather
  // than take down plugin load.
  let runner: PicGoRunner | undefined
  const getLibrary = (): PicGoRunner => {
    runner ??= new PicGoRunner({
      ...config.configPath !== '' ? { configPath: config.configPath } : {},
      silent: config.silent,
      timeoutMs: config.timeoutMs,
    })
    return runner
  }

  const router = new PicGoRouter({
    mode: config.gui.mode,
    probeTtlMs: config.gui.probeTtlMs,
    gui: {
      host: config.gui.host,
      port: config.gui.port,
      secret: config.gui.secret,
      probeTimeoutMs: config.gui.probeTimeoutMs,
      timeoutMs: config.gui.timeoutMs > 0 ? config.gui.timeoutMs : config.timeoutMs,
    },
    getLibrary,
  })
  const getRouter = (): PicGoRouter => router

  ctx.tools.register(createUploadTool(getRouter))

  if (config.registerCommand && ctx.commands !== undefined) {
    ctx.commands.register(createUploadCommand(getRouter))
  }

  if (config.announceSignIn) {
    // Told once at startup so a first-run user learns about the free tier
    // before an upload fails, rather than after. Deferred a tick so building
    // the PicGo instance — which loads the user's third-party uploader
    // plugins — never happens during plugin load.
    let cancelled = false
    ctx.effect(() => {
      const timer = setTimeout(() => {
        announceSignIn(router, ctx.logger, () => cancelled)
          .catch(() => { /* a startup hint must never fail plugin load */ })
      }, 0)
      timer.unref?.()
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    })
  }

  if (config.registerSkill && ctx.skills !== undefined) {
    const skills = ctx.skills
    // Registration is synchronous, but reading the packaged file is not; the
    // effect disposes the registration whether or not the read has landed.
    let dispose: (() => void) | undefined
    let disposed = false

    ctx.effect(() => {
      loadPackagedSkill()
        .then((skill) => {
          if (disposed || skill === undefined) return
          dispose = skills.register(skill)
        })
        .catch((e: unknown) => {
          ctx.logger.warn('failed to register the packaged picgo-upload skill: %o', e)
        })
      return () => {
        disposed = true
        dispose?.()
      }
    })
  }
}
