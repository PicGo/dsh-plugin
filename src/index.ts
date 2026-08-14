import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUploadCommand } from './command.ts'
import { PicGoRunner } from './picgo.ts'
import { loadPackagedSkill } from './skill.ts'
import { createUploadTool } from './tool.ts'

export const name = 'picgo'

// An object here would be read as a name → intercept-config map, not as
// required/optional groups. All three services ship in @deepseek-ai/dsh-base.
export const inject = ['tools', 'commands', 'skills']

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
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string().default(''),
  silent: Schema.boolean().default(true),
  timeoutMs: Schema.number().default(120_000),
  registerSkill: Schema.boolean().default(true),
  registerCommand: Schema.boolean().default(true),
  announceSignIn: Schema.boolean().default(true),
})

/**
 * Point a first-run user at the sign-in. Only speaks up when PicGo Cloud is the
 * active host and there is no usable session — a user with GitHub or S3
 * configured needs no login and should hear nothing.
 */
async function announceSignIn(
  getRunner: () => PicGoRunner,
  logger: Context['logger'],
  cancelled: () => boolean,
): Promise<void> {
  const runner = getRunner()
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
  const getRunner = (): PicGoRunner => {
    runner ??= new PicGoRunner({
      ...config.configPath !== '' ? { configPath: config.configPath } : {},
      silent: config.silent,
      timeoutMs: config.timeoutMs,
    })
    return runner
  }

  ctx.tools.register(createUploadTool(getRunner))

  if (config.registerCommand && ctx.commands !== undefined) {
    ctx.commands.register(createUploadCommand(getRunner))
  }

  if (config.announceSignIn) {
    // Told once at startup so a first-run user learns about the free tier
    // before an upload fails, rather than after. Deferred a tick so building
    // the PicGo instance — which loads the user's third-party uploader
    // plugins — never happens during plugin load.
    let cancelled = false
    ctx.effect(() => {
      const timer = setTimeout(() => {
        announceSignIn(getRunner, ctx.logger, () => cancelled)
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
