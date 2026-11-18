// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RESPONSE_FIELD,
  execute,
  getResponse,
  remove,
  render,
  renderAll,
  reset
} from '../../src/site'

// A fake challenge.faable.com: the real proof-of-work check, at 8 bits so a
// test solves in milliseconds.
type Call = { url: string; body: Record<string, unknown> }
let calls: Call[] = []
let failChallenge = false
let issued = 0

const accepts = (seed: string, bind: string, nonce: string, bits: number) => {
  const d = createHash('sha256').update(`${seed}:${bind}:${nonce}`).digest()
  let z = 0
  for (const byte of d) {
    if (byte === 0) {
      z += 8
      continue
    }
    z += Math.clz32(byte) - 24
    break
  }
  return z >= bits
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

beforeEach(() => {
  calls = []
  failChallenge = false
  issued = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ url, body })
      if (url.endsWith('/v1/challenge')) {
        if (failChallenge) return json(403, { error: 'origin_not_allowed' })
        issued++
        return json(200, {
          id: `c${issued}`,
          kind: 'pow',
          seed: `seed${issued}`,
          email_hash: 'bind',
          difficulty: 8,
          expires_at: new Date(Date.now() + 300_000).toISOString()
        })
      }
      if (url.endsWith('/v1/answer')) {
        const n = Number(String(body.id).slice(1))
        if (!accepts(`seed${n}`, 'bind', body.nonce, 8)) {
          return json(400, { error: 'challenge_bad_nonce' })
        }
        return json(200, {
          token: `fct_token${n}`,
          expires_at: new Date(Date.now() + 300_000).toISOString()
        })
      }
      return json(404, {})
    })
  )
})

afterEach(() => {
  document.querySelectorAll('.faable-challenge').forEach(el => remove(el))
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const page = (attrs = 'data-sitekey="fcs_pk_test"') => {
  document.body.innerHTML = `<form><input name="email"><div class="faable-challenge" ${attrs}></div><button>Send</button></form>`
  return {
    form: document.querySelector('form')!,
    el: document.querySelector('.faable-challenge')!,
    email: document.querySelector('input[name=email]') as HTMLInputElement
  }
}

const hidden = (form: HTMLFormElement) =>
  form.querySelector(`input[name=${RESPONSE_FIELD}]`) as HTMLInputElement

const until = async (fn: () => boolean) => {
  // Up to ~3 s: the badge holds «Checking…» for MIN_SOLVING_MS (1.2 s).
  for (let i = 0; i < 600 && !fn(); i++)
    await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}

describe('site widget', () => {
  it('does nothing until the form is touched, then leaves the token in it', async () => {
    const { form, el, email } = page()
    renderAll(document)
    expect(hidden(form)).toBeTruthy()
    expect(calls).toHaveLength(0)

    email.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await until(() => !!getResponse(el))
    expect(hidden(form).value).toBe('fct_token1')
    expect(calls[0].body).toMatchObject({ site_key: 'fcs_pk_test' })
    expect(new FormData(form).get(RESPONSE_FIELD)).toBe('fct_token1')
  })

  it('sends the action and solves once for many interactions', async () => {
    const { el, email } = page(
      'data-sitekey="fcs_pk_test" data-action="booking"'
    )
    renderAll(document)
    for (let i = 0; i < 3; i++) {
      email.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      email.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await until(() => !!getResponse(el))
    expect(calls.filter(c => c.url.endsWith('/v1/challenge'))).toHaveLength(1)
    expect(calls[0].body.action).toBe('booking')
  })

  it('a send before the token waits for it and goes on by itself', async () => {
    const { form, el } = page()
    renderAll(document)
    const sent: (string | null)[] = []
    form.addEventListener('submit', ev => {
      ev.preventDefault()
      sent.push(new FormData(form).get(RESPONSE_FIELD) as string | null)
    })
    form.requestSubmit()
    expect(sent).toEqual([]) // held
    await until(() => sent.length === 1)
    expect(sent[0]).toBe('fct_token1')
    expect(getResponse(el)).toBe('fct_token1')
  })

  it('execution: load solves at once; manual waits for execute()', async () => {
    const a = page('data-sitekey="fcs_pk_test" data-execution="load"')
    renderAll(document)
    await until(() => !!getResponse(a.el))
    remove(a.el)

    const m = page('data-sitekey="fcs_pk_test" data-execution="manual"')
    renderAll(document)
    m.email.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await new Promise(r => setTimeout(r, 20))
    expect(getResponse(m.el)).toBeNull()
    await expect(execute(m.el)).resolves.toMatch(/^fct_/)
  })

  it('reset spends the token: the next interaction solves a new one', async () => {
    const { el, email } = page()
    const id = render(el, { sitekey: 'fcs_pk_test' })
    await execute(id)
    expect(getResponse(id)).toBe('fct_token1')
    reset(id)
    expect(getResponse(id)).toBeNull()
    email.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await until(() => getResponse(id) === 'fct_token2')
  })

  it('the native form reset clears the token too', async () => {
    const { form, el } = page()
    render(el, { sitekey: 'fcs_pk_test' })
    await execute(el)
    form.reset()
    expect(getResponse(el)).toBeNull()
    expect(hidden(form).value).toBe('')
  })

  it('an error shows the error state, calls back, and a retry tries again', async () => {
    failChallenge = true
    const { el } = page()
    const onError = vi.fn()
    const states: string[] = []
    for (const s of ['solving', 'done', 'error'])
      el.addEventListener(`faable-challenge:${s}`, () => states.push(s))
    render(el, { sitekey: 'fcs_pk_test', 'error-callback': onError })
    await expect(execute(el)).rejects.toThrow('origin_not_allowed')
    expect(onError).toHaveBeenCalledOnce()
    // The badge keeps «Checking…» readable for MIN_SOLVING_MS before it moves on.
    await until(() => states.length === 2)
    expect(states).toEqual(['solving', 'error'])

    failChallenge = false
    el.dispatchEvent(new CustomEvent('faable-challenge:retry'))
    await until(() => !!getResponse(el))
    // The token is there at once; the badge says «done» after its minimum.
    await until(() => states[states.length - 1] === 'done')
  })

  it('renews the token before it expires while the form is on the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { el } = page()
    const onExpired = vi.fn()
    render(el, { sitekey: 'fcs_pk_test', 'expired-callback': onExpired })
    await execute(el)
    expect(getResponse(el)).toBe('fct_token1')
    await vi.advanceTimersByTimeAsync(271_000) // 5 min − 30 s margin
    expect(onExpired).toHaveBeenCalledOnce()
    await until(() => getResponse(el) === 'fct_token2')
  })

  it('two forms on one page keep their own state', async () => {
    document.body.innerHTML = `
      <form id="a"><div class="faable-challenge" data-sitekey="fcs_pk_a"></div></form>
      <form id="b"><div class="faable-challenge" data-sitekey="fcs_pk_b"></div></form>`
    renderAll(document)
    const [a, b] = Array.from(document.querySelectorAll('.faable-challenge'))
    await execute(a)
    expect(getResponse(a)).toMatch(/^fct_/)
    expect(getResponse(b)).toBeNull()
  })

  it('remove takes the widget and its hidden input away', () => {
    const { form, el } = page()
    render(el, { sitekey: 'fcs_pk_test' })
    remove(el)
    expect(hidden(form)).toBeNull()
    expect(getResponse(el)).toBeNull()
  })

  it('a widget without a site key is a clear error', () => {
    const { el } = page('')
    expect(() => render(el, { sitekey: '' })).toThrow(/sitekey/)
  })

  it('a click anywhere on the idle badge starts the check', async () => {
    const { el } = page('data-sitekey="fcs_pk_test" data-execution="manual"')
    render(el, { sitekey: 'fcs_pk_test', execution: 'manual' })
    const tag = el.shadowRoot!.querySelector('.tag') as HTMLElement
    expect(tag.getAttribute('role')).toBe('button')
    tag
      .querySelector('.txt')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    await until(() => !!getResponse(el))
  })

  it('the round badge says what it is (aria-label and title)', () => {
    const { el } = page()
    render(el, { sitekey: 'fcs_pk_test', size: 'compact', locale: 'es' })
    const tag = el.shadowRoot!.querySelector('.tag') as HTMLElement
    expect(tag.getAttribute('aria-label')).toBe(
      'Protegido contra bots · Faable Challenge'
    )
    expect(tag.getAttribute('title')).toBe(tag.getAttribute('aria-label'))
  })
})
