import { isAbsolute, resolve } from 'node:path'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { PicGoUploadError, type CloudAuthState, type PicGoRunner } from './picgo.ts'

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
export function createUploadCommand(getRunner: () => PicGoRunner): CommandDefinition {
  return {
    name: 'picgo',
    description:
      'Upload files to your image host with PicGo. No arguments uploads the clipboard image. '
      + 'Use "/picgo login" to sign in to PicGo Cloud, "/picgo status" to see the active host.',
    input: { hint: 'file paths, or: login [token] | status | logout' },
    async handler({ rawInput, signal }): Promise<CommandResult> {
      const args = splitPaths(rawInput)
      const runner = getRunner()
      const [first, ...rest] = args

      switch (first) {
        case 'login': return login(runner, rest[0], signal)
        case 'logout': return logout(runner)
        case 'status': return status(runner)
        default: return upload(runner, args, signal)
      }
    },
  }
}

async function upload(runner: PicGoRunner, paths: string[], signal: AbortSignal): Promise<CommandResult> {
  // Point a first-run user at the sign-in instead of failing mid-upload.
  if (runner.usesCloud()) {
    const auth = await runner.cloudAuth()
    if (auth.kind === 'logged-out') {
      return {
        kind: 'error',
        text: 'Not signed in to PicGo Cloud. Run "/picgo login" to sign in — the free tier covers casual use.',
      }
    }
    if (auth.kind === 'expired') {
      return { kind: 'error', text: 'Your PicGo Cloud session expired. Run "/picgo login" to sign in again.' }
    }
  }

  try {
    const outcome = paths.length === 0
      ? await runner.uploadClipboard(signal)
      : await runner.uploadFiles(paths.map(p => isAbsolute(p) ? p : resolve(p)), signal)

    const urls = outcome.uploaded.map(item => item.imgUrl).join('\n')
    if (outcome.failed.length === 0) {
      return { kind: 'success', text: urls }
    }
    return {
      kind: 'success',
      text: `${urls}\n\nFailed: ${outcome.failed.join(', ')}`
        + `${outcome.error !== undefined ? `\n${outcome.error}` : ''}`,
    }
  } catch (e) {
    return { kind: 'error', text: e instanceof PicGoUploadError || e instanceof Error ? e.message : String(e) }
  }
}

/**
 * A human typed this, so the blocking browser flow is appropriate here — it is
 * the one place in the plugin where waiting on a person is the correct behavior.
 */
async function login(runner: PicGoRunner, token: string | undefined, signal: AbortSignal): Promise<CommandResult> {
  const onAbort = () => { runner.disposeLogin() }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await runner.cloudLogin(token)
    const auth = await runner.cloudAuth()
    const who = auth.kind === 'logged-in' && auth.user !== undefined ? ` as ${auth.user}` : ''
    return { kind: 'success', text: `Signed in to PicGo Cloud${who}. Uploads will go there.` }
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

async function status(runner: PicGoRunner): Promise<CommandResult> {
  const uploader = runner.currentUploader()
  if (!runner.usesCloud()) {
    return { kind: 'success', text: `Active image host: ${uploader} (no PicGo Cloud sign-in needed).` }
  }
  return { kind: 'success', text: `Active image host: ${uploader}\n${describeAuth(await runner.cloudAuth())}` }
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
