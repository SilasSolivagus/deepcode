// test/settingsLayers.ask.test.ts
import { describe, it, expect } from 'vitest'
import { mergeScopePartials } from '../src/settingsLayers.js'

describe('settingsLayers permissions.ask', () => {
  it('合并各层 ask 并记录来源', () => {
    const r = mergeScopePartials([
      { scope: 'user', partial: { permissions: { ask: ['Bash(rm:*)'] } } },
      { scope: 'project', partial: { permissions: { ask: ['**/.env'] } } },
    ])
    expect(r.settings.permissions.ask).toEqual(['Bash(rm:*)', '**/.env'])
    expect(r.permissionSources.ask['Bash(rm:*)']).toBe('user')
    expect(r.permissionSources.ask['**/.env']).toBe('project')
  })
})
