import { describe, it, expect } from 'bun:test'
import { userDisplayLabel } from '@core/users/displayName'

describe('userDisplayLabel', () => {
  it('uses the trimmed display name, else the email', () => {
    expect(userDisplayLabel({ displayName: ' Alex ', email: 'n@x.de' })).toBe('Alex')
    expect(userDisplayLabel({ displayName: '   ', email: 'n@x.de' })).toBe('n@x.de')
    expect(userDisplayLabel({ displayName: '', email: 'n@x.de' })).toBe('n@x.de')
  })
})
