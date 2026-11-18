// The script for pages without a bundler:
//   <script src="https://challenge.faable.com/v1/api.js" async defer></script>
// Renders every `.faable-challenge[data-sitekey]` on the page (and any added
// later) unless the src says `?render=explicit`; then only
// `FaableChallenge.render(el, opts)` does.
import {
  execute,
  getResponse,
  remove,
  render,
  renderAll,
  reset,
  watch
} from './site'

const api = { render, renderAll, getResponse, execute, reset, remove }

declare global {
  interface Window {
    FaableChallenge?: typeof api
    onFaableChallengeLoad?: () => void
  }
}

if (typeof window !== 'undefined' && !window.FaableChallenge) {
  window.FaableChallenge = api
  const src = (document.currentScript as HTMLScriptElement | null)?.src ?? ''
  const params = (() => {
    try {
      return new URL(src).searchParams
    } catch {
      return new URLSearchParams()
    }
  })()
  if (params.get('render') !== 'explicit') watch()
  const onload = params.get('onload') ?? 'onFaableChallengeLoad'
  const fn = (window as unknown as Record<string, unknown>)[onload]
  if (typeof fn === 'function') {
    try {
      ;(fn as () => void)()
    } catch {
      // the page's callback, its problem
    }
  }
}
