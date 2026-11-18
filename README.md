# @faable/challenge

Bot protection for any form, without puzzles, cookies or third parties. The
widget solves a small proof of work in the browser and leaves a one-time token
in your form; your backend verifies it with Faable before doing anything.

## 1. Add the widget

```html
<form action="/contact" method="post">
  <input name="email" type="email" />
  <div class="faable-challenge" data-sitekey="fcs_pk_…"></div>
  <button>Send</button>
</form>
<script src="https://challenge.faable.com/v1/api.js" async defer></script>
```

The widget starts solving on the first interaction with the form, so the token
is usually ready before the person presses send. If they send earlier, the
submit waits for the token and continues on its own. The token is posted as
`faable-challenge-response` and renewed automatically while the form is open.

With a bundler:

```ts
import { getResponse, render, reset } from '@faable/challenge'

const id = render(document.querySelector('#challenge')!, {
  sitekey: 'fcs_pk_…',
  action: 'contact'
})
// after a send in a single-page app, the token is spent:
reset(id)
```

Options (`data-*` attributes or `render()` options): `sitekey`, `action`,
`execution` (`interaction` · `load` · `manual` with `execute()`),
`responseField`, `callback`, `expired-callback`, `error-callback`. Theme, size
and language: `faable-challenge--dark|--light|--auto`,
`faable-challenge--compact|--normal`, `data-lang="es"`. Events on the element:
`faable-challenge:solving|done|error|idle`.

## 2. Verify on your server

```bash
curl -X POST https://challenge.faable.com/v1/verify \
  -H 'content-type: application/json' \
  -d '{"secret":"fcs_sk_…","response":"<faable-challenge-response>","remoteip":"<client IP>"}'
```

```json
{
  "success": true,
  "hostname": "www.example.com",
  "action": "contact",
  "challenge_ts": "2026-11-18T08:24:16.049Z",
  "error-codes": []
}
```

`remoteip` is optional: `remoteip_match` tells you whether it is the IP that
solved the challenge, and never fails the verify. A token is valid for 5
minutes, for your site's domains, and can be verified once.

## For Faable Auth

auth-js builds its signup protection on the same solver and widget
(`solveChallenge`, `postWithChallenge`, `mountChallengeWidget`), exported here.

License: MIT.
