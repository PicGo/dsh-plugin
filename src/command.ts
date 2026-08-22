import { isAbsolute, resolve } from 'node:path'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { PicGoUploadError, type CloudAuthState, type PicGoRunner } from './picgo.ts'
import type { PicGoRouter } from './router.ts'

/**
 * `/picgo [paths...]` — upload without spending a model turn.
 *
 * With no argument it uploads the clipboard image, which is the whole point of
 * having a human command: the model must never guess that the clipboard should
 * be uploaded, but a human typing the command has said so explicitly.
 *
 * Subcommands:
 *   /picgo login [token]  sign in to PicGo Cloud
 *   /picgo status         show the active host and sign-in state
 */
export function createUploadCommand(getRouter: () => PicGoRouter): CommandDefinition {
  return {
    name: 'picgo',
    description:
      'Upload files to your image host with PicGo. No arguments uploads the clipboard image. '
      + 'Use "/picgo login" to sign in to PicGo Cloud, "/picgo status" to see the active host.',
    input: { hint: 'file paths, or: login [token] | status | logout' },
    async handler({ rawInput, signal }): Promise<CommandResult> {
      const args = splitPaths(rawInput)
      const router = getRouter()
      const [first, ...rest] = args

      // login/logout are library-route concepts by definition: they read and
      // write the PicGo CLI config, which the desktop app does not use.
      switch (first) {
        case 'login': return login(router, rest[0], signal)
        case 'logout': return logout(router.library())
        case 'status': return status(router)
        default: return upload(router, args, signal)
      }
    },
  }
}

async function upload(router: PicGoRouter, paths: string[], signal: AbortSignal): Promise<CommandResult> {
  const absolute = paths.map(p => isAbsolute(p) ? p : resolve(p))

  try {
    // Preflight and upload share one route; see the same note in tool.ts.
    const { result: outcome } = await router.run(async (route) => {
      const preflight = await route.preflight()
      if (preflight.kind === 'sign-in-required') {
        throw new PicGoUploadError(preflight.state === 'expired'
          ? 'Your PicGo Cloud session expired. Run "/picgo login" to sign in again.'
          : 'Not signed in to PicGo Cloud. Run "/picgo login" to sign in — the free tier covers casual use.')
      }
      return absolute.length === 0
        ? route.uploadClipboard(signal)
        : route.uploadFiles(absolute, signal)
    })

    const urls = outcome.uploaded.map(item => item.imgUrl).join('\n')
    const unknown = outcome.failedUnknown ?? 0
    if (outcome.failed.length === 0 && unknown === 0) {
      return { kind: 'success', text: urls }
    }

    const detail = outcome.failed.length > 0
      ? `Failed: ${outcome.failed.join(', ')}`
      : `${unknown} file(s) failed, but the app did not report which`
    return {
      kind: 'success',
      text: `${urls}\n\n${detail}${outcome.error !== undefined ? `\n${outcome.error}` : ''}`,
    }
  } catch (e) {
    return { kind: 'error', text: e instanceof PicGoUploadError || e instanceof Error ? e.message : String(e) }
  }
}

/**
 * A human typed this, so the blocking browser flow is appropriate here — it is
 * the one place in the plugin where waiting on a person is the correct behavior.
 */
async function login(router: PicGoRouter, token: string | undefined, signal: AbortSignal): Promise<CommandResult> {
  const runner = router.library()
  const onAbort = () => { runner.disposeLogin() }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await runner.cloudLogin(token)
    const auth = await runner.cloudAuth()
    const who = auth.kind === 'logged-in' && auth.user !== undefined ? ` as ${auth.user}` : ''

    // Without this a user signs in, sees success, uploads, and lands on a
    // different host with no explanation — the desktop app has its own config
    // and its own session, and it wins route selection while it is running.
    const routed = await router.select({ fresh: true }).catch(() => undefined)
    const caveat = routed?.route.kind === 'gui'
      ? '\nNote: the PicGo desktop app is running and will handle uploads. It uses its own config and '
        + 'its own sign-in, so this login applies only when the app is closed.'
      : ''

    return { kind: 'success', text: `Signed in to PicGo Cloud${who}. Uploads will go there.${caveat}` }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      kind: 'error',
      text: `PicGo Cloud sign-in failed: ${detail}\n`
        + 'If the browser did not open, get a token from the PicGo Cloud dashboard '
        + 'and run "/picgo login <token>".',
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function logout(runner: PicGoRunner): CommandResult {
  try {
    runner.cloudLogout()
    return { kind: 'success', text: 'Signed out of PicGo Cloud.' }
  } catch (e) {
    return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Always probes fresh: a user who just launched the desktop app and typed
 * `status` must not read a cached negative from seconds ago.
 */
async function status(router: PicGoRouter): Promise<CommandResult> {
  let choice
  try {
    choice = await router.select({ fresh: true })
  } catch (e) {
    // gui.mode "only" with no app running. Say so rather than describing a
    // route that will not be used.
    return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
  }

  if (choice.route.kind === 'gui') {
    // The uploader is deliberately absent: the server exposes no way to ask,
    // and printing the library's uploader as if it were the app's would be
    // exactly the lie this route exists to avoid.
    return {
      kind: 'success',
      text: `Upload route: ${choice.route.describe()} (${choice.reason})\n`
        + 'Uploads use the app\'s own config, not the PicGo CLI config, so any host or sign-in below '
        + 'does not apply to them. The app also copies each URL to your clipboard and shows a '
        + 'notification.\n\n'
        + `Fallback if the app stops: ${describeLibrary(router.library())}`,
    }
  }

  return {
    kind: 'success',
    text: `Upload route: in-process PicGo library (${choice.reason})\n`
      + await describeLibraryAuth(router.library()),
  }
}

function describeLibrary(runner: PicGoRunner): string {
  return `in-process library — active host: ${runner.currentUploader()}`
}

async function describeLibraryAuth(runner: PicGoRunner): Promise<string> {
  const uploader = runner.currentUploader()
  if (!runner.usesCloud()) {
    return `Active image host: ${uploader} (no PicGo Cloud sign-in needed).`
  }
  return `Active image host: ${uploader}\n${describeAuth(await runner.cloudAuth())}`
}

function describeAuth(auth: CloudAuthState): string {
  switch (auth.kind) {
    case 'logged-in':
      return `Signed in${auth.user !== undefined ? ` as ${auth.user}` : ''}.`
    case 'logged-out':
      return 'Not signed in. Run "/picgo login" — the free tier covers casual use.'
    case 'expired':
      return 'Session expired. Run "/picgo login" to sign in again.'
    case 'unknown':
      return `Could not check the session (${auth.reason}). This is usually a network problem, not a sign-out.`
  }
}

/**
 * Split a command line into arguments, honoring quotes so a path with spaces
 * survives. Unquoted runs split on whitespace.
 */
export function splitPaths(rawInput: string): string[] {
  const matches = rawInput.match(/"[^"]+"|'[^']+'|\S+/gu) ?? []
  return matches
    .map(token => token.replace(/^["']|["']$/gu, ''))
    .filter(token => token !== '')
}
