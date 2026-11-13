import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@core/support/sha256'

describe('sha256Hex', () => {
  it('matches the platform digest', () => {
    for (const text of ['', 'abc', 'sk-or-v1-0123456789abcdef', 'ü€𝄞'.repeat(40), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })
})
