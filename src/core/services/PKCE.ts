import { createHash, randomBytes } from 'node:crypto'

export interface PKCEPair {
  readonly verifier: string
  readonly challenge: string
}

export const PKCE = {
  generate(): PKCEPair {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: PKCE.challenge(verifier) }
  },

  challenge(verifier: string): string {
    return createHash('sha256').update(verifier, 'utf8').digest('base64url')
  }
}
