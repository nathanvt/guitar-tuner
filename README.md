# Guitar Tuner

A chromatic guitar tuner PWA. It listens through the phone's microphone, shows the note and whether it's flat, sharp or in tune. Everything runs on the phone, and audio never leaves the device. Once installed it works offline.

Vite + TypeScript, no framework. Pitch detection is [pitchy](https://github.com/ianprime0509/pitchy) (McLeod pitch method). `vite-plugin-pwa` handles the manifest and service worker.

## The device

A blocky, old-tech tuner: a grey casing with a dark screen running edge to edge across it. The casing is shaded as one object lit from above: soft gradients, darker toward the left and right edges, a dark lip above the screen, a lit edge below it, and a recess shadow where the screen sits under the casing. The screen's bottom edge carries its seam and shade up with it when the controls open. The name sits on the casing above the screen, and the controls below it: a small mic grille on the left, then controls, then a wide power key on the right. The type is Unbounded (OFL), self-hosted from `@fontsource-variable/unbounded`, Latin subset only.

- **Gauge** (`src/reading.ts`): an arc of 17 wide LED bars above the note, covering −50¢ to +50¢. The center bar is spot on (±2¢ by default; see tolerance), the bars either side of it are close (to ±5¢), and the outer six cover the rest, finer toward the middle. The bars rest grey. The bar at the current pitch lights and grows longer, and its neighbors take a dim version of its color: red when off pitch, green when close. Between two bars the light splits across both, so the reading glides. Each state is left 1¢ outside where it's entered, so colors don't flicker. While the mic starts, light radiates from the center bar out to the ends in repeating waves. Listening with no note, the same ripple runs slower and fainter, so the tuner reads as awake. Hold a note spot on for the settle time (300ms by default) and the display confirms it: the rest of the arc fills grey to green from the center out, the five center bars' glow brightens in turn from the center, and a faint green gradient falls evenly from the top of the screen most of the way down. While that's showing and the mic still hears sound, the note stays fully lit through brief gaps in detection (for up to 2.5s since the last detection). Nothing is drawn while the tuner is off.
- **Note:** a white pixel letter, centered under the center bar. It never moves; the sharp and octave hang off its right side. No words appear while listening.
- **Power:** a push-push key with a pilot light: an unlit dark green while off, lit green (with glow) while on. A tap on the reading area also turns the tuner on, and leaving the app turns it off.
- **Controls:** a second push-push key. The screen lifts like a lid to uncover a controls tray anchored beneath it; the reading glides up (and shrinks only if it must) to stay centered in what's left. The lift is all clip and transform, so the reading isn't redrawn mid-animation. The tray has two pages, picked with the **display** / **tuning** switch beside its title. Dials are rotary knobs; every other setting is a flat segmented control whose highlight slides to the selected option:
  - **Display:** *contrast* dial (−5 to +5, 0 straight up as the default); *colors*, three good/bad pairs: green/red (default), teal/magenta, and blue/orange (the colorblind-safe pair); *theme*, dark or light (pale casing, near-white screen, near-black ink); *glow*, off / low / hi, with a light beside the label showing the current strength; *gradient*, on / off, for the confirmation's background light (the arc's own confirmation is unaffected).
  - **Tuning:** *mic sensitivity* dial (0 to 10, each step moves the noise gate 3dB; 5 is −50dB); *tolerance*, the spot-on band: tight ±1¢ / mid ±2¢ / loose ±3¢; *response*, how fast the reading follows pitch: calm / mid / quick; *settle*, how long a note must hold spot on before the display confirms it (its dwell time): short 150ms / mid 300ms / long 600ms; *auto-off*, off / 2 / 5 minutes without a note.

  Every setting is saved in the browser. With the tuner off, the reading shows a preview while the tray is open.
- The power and controls keys stay down until their action has run, then move straight to their new position, so a key never bounces between states.
- The reading sits on the screen's optical center (46% down) where there's room, and fills short screens evenly.
- **Mic grille** (`src/grille.ts`): sits over the phone's own microphone. Four holes across; they light from the bottom up with input level, like a peak meter.
- Errors (mic blocked, busy, missing, no https) show where the note goes, under the grey gauge bars, with a pixel warning triangle and an orange title. The power key pops back up and its pilot flashes orange.
- The page background is casing grey, so whatever Safari shows around the page matches the casing.

## Run

```bash
npm install
npm run serve     # build, then serve on http://127.0.0.1:4750
npm run tunnel    # temporary https URL for testing on the phone
```

The microphone only works over https, so the phone has to use the tunnel URL, not the Mac's local IP. The URL changes every time the tunnel starts.

`npm run dev` runs the hot-reloading dev server on the same port. Use `serve` for phone tests: the tunnel then exposes only built files, and the service worker behaves as it will in production.

## Deploy

Live at **https://guitar-tuner.njvantwisk.workers.dev**.

It's a static app on a Cloudflare Worker (static assets only, no Worker script; see `wrangler.jsonc`), built by Cloudflare's GitHub integration: **pushing `main` deploys**. `npm run deploy` (build, then `wrangler deploy`) is there for a manual deploy, but only with a Wrangler login for the right account.

## Install on iPhone

Open the live URL in Safari, then Share → Add to Home Screen.

## Checks

- `npm run check:pitch` runs synthetic plucked strings through the real tracker. It covers every open string, detuned both ways, plus silence and noise.
- `npm run icons` redraws `public/icons/*.png` and `public/favicon.svg` to match the tuner: the glowing green arc and a white pixel E on black with a soft radial light.

## Dependency rule

`.npmrc` sets `min-release-age=4`: npm won't install any package version, direct or transitive, published less than 4 days ago. Tools from outside npm (like `cloudflared` from Homebrew) get their release date checked by hand before install.
