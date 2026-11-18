// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHALLENGE_EVENT, postWithChallenge } from '../../src/solver'

let badge: string[] = []
const onEvent = (ev: Event) =>
  badge.push((ev as CustomEvent<{ state: string }>).detail.state)
beforeEach(() => {
  badge = []
  window.addEventListener(CHALLENGE_EVENT, onEvent)
})
afterEach(() => window.removeEventListener(CHALLENGE_EVENT, onEvent))

const challenge = {
  id: 'c1',
  kind: 'pow',
  seed: 'seed',
  email_hash: createHash('sha256').update('a@b.c').digest('hex'),
  difficulty: 4,
  expires_at: new Date(Date.now() + 300_000).toISOString()
}

describe('postWithChallenge and the badge', () => {
  it('a send that needs no challenge: «checking», then «done»; onChallenge is not called', async () => {
    const calls: string[] = []
    const r = await postWithChallenge(
      async () => ({ data: { ok: true } }),
      s => calls.push(s)
    )
    expect(r.data).toEqual({ ok: true })
    expect(badge).toEqual(['solving', 'done'])
    expect(calls).toEqual([])
  })

  it('a send refused for another reason goes back to rest, never «done»', async () => {
    await postWithChallenge(async () => ({
      error: new Error('bad email'),
      code: 'invalid_email'
    }))
    expect(badge).toEqual(['solving', 'idle'])
  })

  it('a send that throws goes back to rest and rethrows', async () => {
    await expect(
      postWithChallenge(async () => {
        throw new Error('network')
      })
    ).rejects.toThrow('network')
    expect(badge).toEqual(['solving', 'idle'])
  })

  it('a challenge: solved and sent again; onChallenge sees solving and done', async () => {
    const calls: string[] = []
    let n = 0
    const r = await postWithChallenge(
      async c => {
        n++
        if (!c)
          return {
            error: new Error('challenge'),
            code: 'challenge_required',
            data: { details: challenge }
          }
        return { data: { sent: true, nonce: c.nonce } }
      },
      s => calls.push(s)
    )
    expect(n).toBe(2)
    expect((r.data as { sent: boolean }).sent).toBe(true)
    expect(calls).toEqual(['solving', 'done'])
    expect(badge[badge.length - 1]).toBe('done')
  })
})
