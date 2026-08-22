/**
 * What every upload route shares.
 *
 * These types live here rather than in `picgo.ts` so that a route which does
 * not use the `picgo` library — the desktop-app route in `server.ts` — can
 * import them without pulling `import { PicGo } from 'picgo'` and its whole
 * dependency tree into its module graph.
 */

/** One file that a route accepted and turned into a hosted URL. */
export interface UploadedItem {
  /** The hosted URL. Always present — an item without one is a failure, not a result. */
  imgUrl: string
  fileName?: string
  /** Uploader id that produced the URL, e.g. `github`, `smms`, `picgo-cloud`. */
  type?: string
  size?: number
  width?: number
  height?: number
}

/** Outcome of one upload call, including the partial-success case. */
export interface UploadOutcome {
  uploaded: UploadedItem[]
  /** Inputs that produced no URL, named. Empty on full success. */
  failed: string[]
  /**
   * How many inputs failed without the route being able to say which.
   *
   * Only ever set by the desktop-app route talking to a PicGo old enough to
   * omit `origin` from its response. Naming the wrong file is worse than
   * admitting we cannot tell, so that case reports a count instead of guessing.
   */
  failedUnknown?: number
  /**
   * The uploader that actually handled the batch, when known after the fact.
   * On the desktop-app route this is the only trustworthy source — its config
   * cannot be read ahead of time.
   */
  uploader?: string
  /** Why the upload failed, when anything did. */
  error?: string
}

/** An upload that produced nothing usable. */
export class PicGoUploadError extends Error {
  override name = 'PicGoUploadError'
}

/**
 * What must happen before an upload can succeed on a given route.
 *
 * This is per-route on purpose: the two routes read different config files, so
 * "is the user signed in" has a different answer — and sometimes no knowable
 * answer — depending on which one will run.
 */
export type PreflightResult =
  | { kind: 'ok' }
  | { kind: 'sign-in-required'; state: 'logged-out' | 'expired' }

/** A way to get local files uploaded, whatever machinery sits behind it. */
export interface UploadRoute {
  readonly kind: 'library' | 'gui'
  /** One line naming this route, for `/picgo status` and error messages. */
  describe(): string
  /** Best guess at the uploader before an upload runs; empty when unknowable. */
  currentUploader(): string
  /** What must happen before an upload can succeed on this route. */
  preflight(): Promise<PreflightResult>
  uploadFiles(paths: string[], signal: AbortSignal): Promise<UploadOutcome>
  uploadClipboard(signal: AbortSignal): Promise<UploadOutcome>
}

/** The subset of PicGo's image info that both routes actually read. */
export interface ImgInfoLike {
  imgUrl?: unknown
  fileName?: unknown
  type?: unknown
  size?: unknown
  width?: unknown
  height?: unknown
}

/** An entry counts as uploaded only once it carries a URL. */
export function isUploaded(item: ImgInfoLike): boolean {
  return typeof item.imgUrl === 'string' && item.imgUrl !== ''
}

/** Narrow a raw entry to the fields callers rely on, dropping the rest. */
export function toUploadedItem(item: ImgInfoLike): UploadedItem {
  return {
    imgUrl: item.imgUrl as string,
    ...typeof item.fileName === 'string' ? { fileName: item.fileName } : {},
    ...item.type !== undefined && item.type !== null ? { type: String(item.type) } : {},
    ...typeof item.size === 'number' ? { size: item.size } : {},
    ...typeof item.width === 'number' ? { width: item.width } : {},
    ...typeof item.height === 'number' ? { height: item.height } : {},
  }
}
