import { isAbsolute, resolve } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PicGoRunner, UploadOutcome } from './picgo.ts'

/** Fields a caller can rely on; PicGo marks the rest optional per uploader. */
const UPLOADED_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    imgUrl: { type: 'string', required: true, description: 'Public URL of the uploaded file' },
    fileName: { type: 'string', description: 'File name as stored on the host' },
    type: { type: 'string', description: 'Uploader that produced the URL, e.g. github, smms, picgo-cloud' },
    size: { type: 'integer', description: 'Size in bytes' },
    width: { type: 'integer', description: 'Image width in pixels' },
    height: { type: 'integer', description: 'Image height in pixels' },
  },
} as const

export function createUploadTool(getRunner: () => PicGoRunner): ToolDefinition {
  return defineTool({
    name: 'picgo_upload',
    description:
      'Upload local images or files to the user\'s configured image host with PicGo and return public URLs. '
      + 'Use this whenever a local file needs to become a link — inserting a screenshot into a README, blog post, '
      + 'or note; turning a generated chart into an embeddable image; sharing a PDF or zip as a download link. '
      + 'Uploads to whatever host the user already configured in PicGo (PicGo Cloud, GitHub, S3, and others). '
      + 'Do NOT use when the user named a specific destination (a cloud drive, object storage, npm, scp), or when '
      + 'they want to save a file locally or download a remote one. '
      + 'Returned URLs are publicly accessible — for a non-image file that looks sensitive, confirm before uploading.',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          'Absolute paths of the files to upload, in order. Relative paths resolve against the process working '
          + 'directory. Must not be empty — pass at least one file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uploaded: {
            type: 'array',
            items: UPLOADED_ITEM,
            required: true,
            description: 'Successfully uploaded files, in input order',
          },
          failed: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Input paths that produced no URL; empty when every file succeeded',
          },
          uploader: {
            type: 'string',
            required: true,
            description: 'The PicGo uploader that handled this batch',
          },
          error: { type: 'string', description: 'Why some files failed, when any did' },
        },
      },
      render: (_args, value) => {
        const lines = value.uploaded.map(item => item.imgUrl)
        if (value.failed.length > 0) {
          lines.push(
            `\n${value.failed.length} of ${value.uploaded.length + value.failed.length} failed: `
            + `${value.failed.join(', ')}${value.error !== undefined ? ` — ${value.error}` : ''}`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: args.paths.length === 1
        ? `Upload ${basename(args.paths[0] ?? '')} to image host`
        : `Upload ${args.paths.length} files to image host`,
      kind: 'other',
      locations: args.paths.map(path => ({ path })),
    }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      return { card: 'generic', title: 'Uploaded to image host' }
    },
    async execute(args, exec) {
      const paths = args.paths.map(path => path.trim()).filter(path => path !== '')
      if (paths.length === 0) {
        // PicGo reads an empty input list as "upload the clipboard image", which
        // would silently upload something the caller never asked for.
        throw new Error('picgo_upload requires at least one file path.')
      }

      const runner = getRunner()

      // Catch the first-run case before spending an upload on it. The browser
      // sign-in blocks on a callback, so the model must not start it — say what
      // the user should do and let them do it.
      if (runner.usesCloud()) {
        const auth = await runner.cloudAuth()
        if (auth.kind === 'logged-out' || auth.kind === 'expired') {
          throw new Error(signInMessage(auth.kind))
        }
      }

      const absolute = paths.map(path => isAbsolute(path) ? path : resolve(path))
      const outcome = await runner.uploadFiles(absolute, exec.signal)
      return toCanonical(outcome, runner.currentUploader())
    },
  })
}

export function toCanonical(outcome: UploadOutcome, uploader: string): {
  uploaded: UploadOutcome['uploaded']
  failed: string[]
  uploader: string
  error?: string
} {
  return {
    uploaded: outcome.uploaded,
    failed: outcome.failed,
    uploader,
    ...outcome.error !== undefined ? { error: outcome.error } : {},
  }
}

/**
 * What to tell the model when PicGo Cloud needs a sign-in. It is addressed to
 * the model because the model reads it: it must relay the instruction rather
 * than retry, and it must not run `picgo login` itself — with no token that
 * command opens a browser and blocks forever in an agent context.
 */
export function signInMessage(kind: 'logged-out' | 'expired'): string {
  const lead = kind === 'expired'
    ? 'The PicGo Cloud session has expired.'
    : 'PicGo Cloud is the active image host, but nobody has signed in yet.'
  return `${lead} Tell the user to run "/picgo login" in this session — it opens the browser sign-in `
    + 'and reports back when it completes. PicGo Cloud has a free tier that covers casual use. '
    + 'If they already have a token from the PicGo Cloud dashboard, "/picgo login <token>" is instant. '
    + 'Do NOT run "picgo login" yourself and do NOT retry this upload until they confirm they are signed in.'
}

/** Presenters run on replay, so this stays a pure string operation. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/u)
  return parts[parts.length - 1] || path
}
