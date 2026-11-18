// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mountChallengeWidgets, watchChallengeWidgets } from '../../src/widget'

// auth-js mounts the badges through these helpers and needs its `onMount`
// (it fetches the form transaction token when a form shows up).
describe('driver passthrough', () => {
  it('mountChallengeWidgets hands the driver to every mount', () => {
    document.body.innerHTML =
      '<form><div data-faable-challenge></div></form><div data-faable-challenge></div>'
    const onMount = vi.fn()
    mountChallengeWidgets(document, { onMount })
    expect(onMount).toHaveBeenCalledTimes(2)
    // Idempotent: an element already mounted is not mounted again.
    mountChallengeWidgets(document, { onMount })
    expect(onMount).toHaveBeenCalledTimes(2)
  })

  it('watchChallengeWidgets uses it for badges added later', async () => {
    document.body.innerHTML = ''
    const onMount = vi.fn()
    watchChallengeWidgets({ onMount })
    const el = document.createElement('div')
    el.setAttribute('data-faable-challenge', '')
    document.body.appendChild(el)
    await new Promise(r => setTimeout(r, 0))
    expect(onMount).toHaveBeenCalledTimes(1)
  })
})
