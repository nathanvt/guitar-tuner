# Guitar Tuner

A chromatic guitar tuner PWA. It listens through the phone's microphone, shows the note and how far off it is, and highlights the nearest open string. Everything runs on the phone, and audio never leaves the device. Once installed it works offline.

Vite + TypeScript, no framework. Pitch detection is [pitchy](https://github.com/ianprime0509/pitchy) (McLeod pitch method). `vite-plugin-pwa` handles the manifest and service worker.

## Run

```bash
npm install
npm run serve     # build, then serve on http://127.0.0.1:4750
npm run tunnel    # temporary https URL for testing on the phone
```

The microphone only works over https, so the phone has to use the tunnel URL, not the Mac's local IP. The URL changes every time the tunnel starts.

`npm run dev` runs the hot-reloading dev server on the same port. Use `serve` for phone tests: the tunnel then exposes only built files, and the service worker behaves as it will in production.

## Install on iPhone

Open the tunnel URL in Safari, then Share → Add to Home Screen.

## Checks

- `npm run check:pitch` runs synthetic plucked strings through the real tracker. It covers every open string, detuned both ways, plus silence and noise.
- `npm run icons` redraws `public/icons/*.png` from the same geometry as `public/favicon.svg`.

## Dependency rule

`.npmrc` sets `min-release-age=4`: npm won't install any package version, direct or transitive, published less than 4 days ago. Tools from outside npm (like `cloudflared` from Homebrew) get their release date checked by hand before install.
