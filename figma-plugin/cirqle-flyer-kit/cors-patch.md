# Optional: let the plugin fetch the model over the network

**You do not need this to use the plugin.** The Settings tab can load
`u2netp.onnx` straight from disk, which always works. This patch only removes
that one-time file pick.

## Why it's needed

`next.config.ts` currently sends these on every route:

```
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
```

…and no `Access-Control-Allow-Origin` anywhere. A Figma plugin's UI runs in a
sandboxed iframe with a `null` origin, so when it calls

```js
fetch('https://app.cirqle.work/models/u2netp.onnx')
```

the browser blocks the response. Nothing is wrong with the file or the URL —
the server just never says the request is allowed.

## The change

Add one entry to the existing `headers()` array in `next.config.ts`, **before**
the catch-all `/(.*)` rule:

```ts
async headers() {
  return [
    {
      // The background-removal model and its WASM runtime are static, public,
      // non-secret assets. They are fetched by the Cirqle Figma plugin, whose
      // iframe has a null origin, so they need an explicit CORS allow. Scoped
      // to /models/ so nothing else in the app becomes cross-origin readable.
      source: '/models/:path*',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: '*' },
        { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        // ~18MB that never changes — cache it hard.
        { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      ],
    },
    {
      source: '/(.*)',
      headers: [
        // …leave the existing security headers exactly as they are…
      ],
    },
  ]
}
```

## Is this safe?

Yes, and it's narrowly scoped:

- It only covers `/models/`, which holds the u2netp weights and the ONNX
  WebAssembly runtime. Both are public open-source artifacts (Apache-2.0 and
  MIT). Neither contains customer data.
- Everything already in `public/` is served to anyone who knows the URL. This
  changes *who may read the response in a script*, not whether the file is
  reachable.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'` still apply to your
  pages, so the app itself still can't be framed. Those headers are about
  embedding the app, not about fetching a static file.
- No API route, server action, or authenticated page is affected.

After deploying, clear the file picker in Settings and the plugin will pull the
model from your own domain.
