import { ChallengeDetails, isChallengeDetails, solveChallenge } from './solver'
import {
  ChallengeWidget,
  ChallengeWidgetOptions,
  mountChallengeWidget
} from './widget'

/**
 * Faable Challenge on any form: the widget asks challenge.faable.com for a
 * challenge with the site's public key, solves it, trades it for a response
 * token and leaves it in the form as `faable-challenge-response`. The site's
 * backend verifies that token with its secret (`POST /v1/verify`).
 *
 *   <form>
 *     …
 *     <div class="faable-challenge" data-sitekey="fcs_pk_…"></div>
 *     <button>Send</button>
 *   </form>
 *
 * By default it solves on the first interaction with the form (focus or
 * typing), so by the time the person presses send the token is there. If they
 * send before it is, the submit waits for it and goes on by itself. The token
 * lasts 5 minutes: while the form is on the page it is renewed on its own.
 */

export const DEFAULT_API = 'https://challenge.faable.com'
export const RESPONSE_FIELD = 'faable-challenge-response'
// Renew this long before the server's expiry, so a send at the last second
// does not carry a token that dies on its way.
const RENEW_MARGIN_MS = 30_000

export type Execution = 'interaction' | 'load' | 'manual'

export type RenderOptions = ChallengeWidgetOptions & {
  sitekey: string
  /** Free label (≤ 64 chars) the backend can check in verify: `contact`, `booking`. */
  action?: string
  /** When to solve: first interaction with the form (default), at once, or on `execute()`. */
  execution?: Execution
  api?: string
  /** Name of the hidden input (default `faable-challenge-response`). */
  responseField?: string
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: (error: unknown) => void
}

type Instance = {
  id: string
  el: Element
  opts: RenderOptions
  widget: ChallengeWidget
  input: HTMLInputElement | null
  token: string | null
  running: Promise<string> | null
  abort: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  cleanup: (() => void)[]
}

const INSTANCES = new Map<string, Instance>()
const BY_ELEMENT = new WeakMap<Element, Instance>()
let seq = 0

const post = async (
  url: string,
  body: unknown,
  signal: AbortSignal
): Promise<Record<string, unknown>> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    credentials: 'omit'
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = new Error(String(data.error ?? `HTTP ${res.status}`))
    ;(err as Error & { code?: unknown }).code = data.error
    throw err
  }
  return data
}

const safely = (fn: (() => void) | undefined) => {
  try {
    fn?.()
  } catch {
    // A throwing integrator callback must not break the form.
  }
}

const setToken = (inst: Instance, token: string | null) => {
  inst.token = token
  if (inst.input) inst.input.value = token ?? ''
}

const solveOnce = async (inst: Instance): Promise<string> => {
  const api = (inst.opts.api ?? DEFAULT_API).replace(/\/$/, '')
  inst.abort?.abort()
  const abort = new AbortController()
  inst.abort = abort
  const details = await post(
    `${api}/v1/challenge`,
    { site_key: inst.opts.sitekey, action: inst.opts.action },
    abort.signal
  )
  if (!isChallengeDetails(details)) throw new Error('invalid challenge')
  const nonce = await solveChallenge(details as ChallengeDetails, {
    signal: abort.signal
  })
  const answer = await post(
    `${api}/v1/answer`,
    { id: details.id, nonce },
    abort.signal
  )
  if (typeof answer.token !== 'string') throw new Error('invalid answer')
  schedule(inst, answer.expires_at)
  return answer.token
}

/** Renew before expiry while the form is on the page; stop once it is gone. */
const schedule = (inst: Instance, expires_at: unknown) => {
  if (inst.timer) clearTimeout(inst.timer)
  const at = typeof expires_at === 'string' ? Date.parse(expires_at) : NaN
  // A local clock minutes off the server's: assume the 5-minute TTL.
  let ms = at - Date.now()
  if (!Number.isFinite(ms) || ms <= 0 || ms > 10 * 60_000) ms = 300_000
  inst.timer = setTimeout(
    () => {
      inst.timer = null
      if (!INSTANCES.has(inst.id)) return
      setToken(inst, null)
      inst.widget.setState('idle')
      safely(() => inst.opts['expired-callback']?.())
      if (inst.el.isConnected) void run(inst).catch(() => {})
    },
    Math.max(ms - RENEW_MARGIN_MS, 1_000)
  )
}

const run = (inst: Instance): Promise<string> => {
  if (inst.token) return Promise.resolve(inst.token)
  if (inst.running) return inst.running
  inst.widget.setState('solving')
  inst.running = solveOnce(inst)
    .then(token => {
      setToken(inst, token)
      inst.widget.setState('done')
      safely(() => inst.opts.callback?.(token))
      return token
    })
    .catch(err => {
      if ((err as Error)?.name !== 'AbortError') {
        inst.widget.setState('error')
        safely(() => inst.opts['error-callback']?.(err))
      }
      throw err
    })
    .finally(() => {
      inst.running = null
    })
  return inst.running
}

const resolveInstance = (ref?: string | Element): Instance | undefined => {
  if (ref === undefined) return INSTANCES.values().next().value
  return typeof ref === 'string' ? INSTANCES.get(ref) : BY_ELEMENT.get(ref)
}

/** Draws the widget in `el` and protects its form. Returns the widget id. */
export const render = (el: Element, opts: RenderOptions): string => {
  const existing = BY_ELEMENT.get(el)
  if (existing) return existing.id
  if (!opts?.sitekey) throw new Error('Faable Challenge: sitekey is required')

  const widget = mountChallengeWidget(el, opts, {
    followWindowEvents: false,
    product: 'challenge'
  })
  const form = el.closest('form')
  let input: HTMLInputElement | null = null
  if (typeof document !== 'undefined') {
    input = document.createElement('input')
    input.type = 'hidden'
    input.name = opts.responseField ?? RESPONSE_FIELD
    // Inside the form when there is one (so it is sent with it), next to the
    // widget otherwise (a page that reads it with getResponse).
    if (form) form.appendChild(input)
    else el.after(input)
  }

  const inst: Instance = {
    id: `fc-${++seq}`,
    el,
    opts,
    widget,
    input,
    token: null,
    running: null,
    abort: null,
    timer: null,
    cleanup: []
  }
  INSTANCES.set(inst.id, inst)
  BY_ELEMENT.set(el, inst)

  const execution = opts.execution ?? 'interaction'
  const start = () => void run(inst).catch(() => {})

  // Retry from the error state (click or Enter on the badge).
  const onRetry = () => start()
  el.addEventListener('faable-challenge:retry', onRetry)
  inst.cleanup.push(() =>
    el.removeEventListener('faable-challenge:retry', onRetry)
  )

  if (form) {
    if (execution === 'interaction') {
      const onInteract = () => start()
      form.addEventListener('focusin', onInteract)
      form.addEventListener('input', onInteract)
      inst.cleanup.push(() => {
        form.removeEventListener('focusin', onInteract)
        form.removeEventListener('input', onInteract)
      })
    }
    // A send before the token: hold it, solve, and send again.
    let resubmitting = false
    const onSubmit = (ev: Event) => {
      if (inst.token || resubmitting) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      const submitter = (ev as SubmitEvent).submitter ?? undefined
      run(inst)
        .then(() => {
          resubmitting = true
          try {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit(submitter as HTMLElement | undefined)
            } else {
              form.submit()
            }
          } finally {
            resubmitting = false
          }
        })
        .catch(() => {})
    }
    form.addEventListener('submit', onSubmit, true)
    // The native reset: a fresh token for the next send.
    const onReset = () => reset(inst.id)
    form.addEventListener('reset', onReset)
    inst.cleanup.push(() => {
      form.removeEventListener('submit', onSubmit, true)
      form.removeEventListener('reset', onReset)
    })
  }

  if (execution === 'load' || (execution === 'interaction' && !form)) start()
  return inst.id
}

/** The current response token, or null while there is none. */
export const getResponse = (ref?: string | Element): string | null =>
  resolveInstance(ref)?.token ?? null

/** Solves now (execution: 'manual'), resolving with the token. */
export const execute = (ref?: string | Element): Promise<string> => {
  const inst = resolveInstance(ref)
  if (!inst) return Promise.reject(new Error('Faable Challenge: no widget'))
  return run(inst)
}

/**
 * A fresh start for a form that stays on the page after a send (the token it
 * carried is spent). The next interaction solves again.
 */
export const reset = (ref?: string | Element): void => {
  const inst = resolveInstance(ref)
  if (!inst) return
  inst.abort?.abort()
  if (inst.timer) clearTimeout(inst.timer)
  inst.timer = null
  setToken(inst, null)
  inst.widget.reset()
  if ((inst.opts.execution ?? 'interaction') === 'load') {
    void run(inst).catch(() => {})
  }
}

export const remove = (ref?: string | Element): void => {
  const inst = resolveInstance(ref)
  if (!inst) return
  inst.abort?.abort()
  if (inst.timer) clearTimeout(inst.timer)
  inst.cleanup.forEach(fn => fn())
  inst.widget.unmount()
  inst.input?.remove()
  INSTANCES.delete(inst.id)
  BY_ELEMENT.delete(inst.el)
}

// --------------------------------------------------------- declarative

export const SELECTOR = '.faable-challenge[data-sitekey]'

const fromDataset = (el: Element): RenderOptions => {
  const d = (el as HTMLElement).dataset ?? {}
  const callback = (name?: string) => {
    const fn =
      name && typeof window !== 'undefined'
        ? (window as unknown as Record<string, unknown>)[name]
        : undefined
    return typeof fn === 'function'
      ? (fn as (...a: unknown[]) => void)
      : undefined
  }
  const execution = d.execution as Execution | undefined
  return {
    sitekey: d.sitekey ?? '',
    action: d.action,
    api: d.api,
    responseField: d.responseField,
    execution:
      execution === 'load' || execution === 'manual' ? execution : undefined,
    locale: d.lang,
    callback: callback(d.callback),
    'expired-callback': callback(d.expiredCallback),
    'error-callback': callback(d.errorCallback)
  }
}

/** Renders every `.faable-challenge[data-sitekey]` under `root`. */
export const renderAll = (root: ParentNode = document): void => {
  const els: Element[] =
    root instanceof Element && root.matches(SELECTOR) ? [root] : []
  els.push(...Array.from(root.querySelectorAll(SELECTOR)))
  for (const el of els) {
    if (!BY_ELEMENT.has(el)) render(el, fromDataset(el))
  }
}

let watching = false

/** Renders the widgets on the page now and any added later. Idempotent. */
export const watch = (): void => {
  if (watching || typeof document === 'undefined') return
  watching = true
  const scan = () => renderAll(document)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true })
  } else {
    scan()
  }
  if (typeof MutationObserver !== 'function') return
  new MutationObserver(records => {
    for (const r of records) {
      r.addedNodes.forEach(node => {
        if (node instanceof Element) renderAll(node)
      })
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}
