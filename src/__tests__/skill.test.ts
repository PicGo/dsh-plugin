import { describe, expect, it } from 'vitest'
import { loadPackagedSkill } from '../skill.ts'

describe('packaged skill', () => {
  it('loads and satisfies what ctx.skills.register() validates', async () => {
    const skill = await loadPackagedSkill()

    expect(skill).toBeDefined()
    // The registry rejects anything missing these; see validateDefinition().
    expect(skill?.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    expect(typeof skill?.description).toBe('string')
    expect(skill?.description.length).toBeGreaterThan(0)
    expect(typeof skill?.content).toBe('string')
    expect(skill?.content.length).toBeGreaterThan(0)
    expect(typeof skill?.source).toBe('string')
  })

  it('strips the frontmatter from the body', async () => {
    const skill = await loadPackagedSkill()
    expect(skill?.content.startsWith('---')).toBe(false)
    expect(skill?.content).toContain('# PicGo Upload')
  })

  it('unescapes quotes in the description', async () => {
    const skill = await loadPackagedSkill()
    expect(skill?.description).not.toContain('\\"')
    expect(skill?.description).toContain('"upload an image"')
  })

  it('points the model at the tool, not the old CLI routing', async () => {
    const skill = await loadPackagedSkill()
    expect(skill?.content).toContain('picgo_upload')
    // The dsh plugin replaces the GUI-server / CLI fallback ladder.
    expect(skill?.content).not.toContain('gui-upload.mjs')
  })
})
