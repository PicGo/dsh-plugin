import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/**
 * The packaged skill ships beside the built entry point, so resolve it from
 * this module's own URL rather than the process working directory.
 *
 * Built to `lib/index.js`, so `skills/` sits one level up. Both paths are tried
 * because the source tree has `src/` at the same depth.
 */
const CANDIDATE_DIRS = ['../skills/picgo-upload', '../../skills/picgo-upload']

/** Frontmatter delimiters used by the packaged SKILL.md. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u

/**
 * Load the packaged skill so it can be handed to `ctx.skills.register()`.
 *
 * Registering at runtime avoids reconfiguring `dsh-skill-filesystem`: a patch
 * replaces a row's entire `config`, so contributing a directory there would
 * mean restating every key of a row other bundles also want to own.
 *
 * @returns the registration, or undefined when the packaged file is unreadable.
 */
export async function loadPackagedSkill(): Promise<SkillRegistration | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))

  for (const candidate of CANDIDATE_DIRS) {
    const path = join(here, candidate, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }

    const description = readDescription(raw)
    if (description === undefined) return undefined

    return {
      name: 'picgo-upload',
      description,
      content: raw.replace(FRONTMATTER, ''),
      source: 'bundled',
      path,
      invocation: { modelInvocable: true, userInvocable: true },
    }
  }
  return undefined
}

/**
 * Pull `description` out of the frontmatter. The value is a double-quoted
 * single-line YAML scalar in the packaged file, which is all this needs to
 * handle — a full YAML parser would be a dependency for one known field.
 */
function readDescription(raw: string): string | undefined {
  const frontmatter = FRONTMATTER.exec(raw)?.[1]
  if (frontmatter === undefined) return undefined

  const line = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim()
  if (line === undefined || line === '') return undefined

  const unquoted = /^"([\s\S]*)"$/u.exec(line)?.[1] ?? /^'([\s\S]*)'$/u.exec(line)?.[1] ?? line
  return unquoted.replace(/\\"/gu, '"')
}
