# Guitar Tuner

A chromatic guitar tuner PWA. It listens through the phone's microphone, shows the note and whether it's flat, sharp or in tune. Everything runs on the phone, and audio never leaves the device. Once installed it works offline.

Vite + TypeScript, no framework. Pitch detection is [pitchy](https://github.com/ianprime0509/pitchy) (McLeod pitch method). `vite-plugin-pwa` handles the manifest and service worker.

## The device

A blocky, old-tech tuner: a grey casing with a dark screen running edge to edge across it. The name sits on the casing above the screen, and the controls below it: a small mic grille on the left, then controls, then a wide power key on the right. The type is Unbounded (OFL), self-hosted from `@fontsource-variable/unbounded`, Latin subset only.

- **Gauge** (`src/reading.ts`): an arc of 17 wide LED bars above the note, covering −50¢ to +50¢. The bars rest grey. The bar at the current pitch lights red and grows longer; between two bars the light splits across both, so the reading glides. Within 3¢, the whole arc lights green. Hold it there for 400ms and the display confirms it: a faint green gradient falls from the top of the screen, and the bars' glow grows a little. Nothing is drawn while the tuner is off.
- **Note:** a white pixel letter, centered under the center bar. It never moves; the sharp and octave hang off its right side. No words appear while listening.
- **Power:** a push-push key with a pilot light: an unlit dark green while off, lit green (with glow) while on. A tap on the reading area also turns the tuner on, and leaving the app turns it off.
- **Controls:** a second push-push key. The screen lifts like a lid to uncover a slate-grey controls tray anchored beneath it; the reading glides up (and shrinks only if it must) to stay centered in what's left. The lift is all clip and transform, so the reading isn't redrawn mid-animation. In the tray:
  - **Brightness** dial, in `src/dial.ts`: detents from −5 to +5, with 0 straight up as the default. −5 dims the reading to 20%, +5 is full. Turn it by dragging up or right, or with the arrow keys.
  - **Glow:** three interlocking keys, off / low / hi, for the light around the reading, the pilot light and the mic grille. Touching one latches it and releases the others. A small green light beside the label shows the current strength.

  Settings are saved in the browser. With the tuner off, the reading shows a preview while the dashboard is open.
- Keys stay down until their action has run, then move straight to their new position, so a key never bounces between states.
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

## Install on iPhone

Open the tunnel URL in Safari, then Share → Add to Home Screen.

## Checks

- `npm run check:pitch` runs synthetic plucked strings through the real tracker. It covers every open string, detuned both ways, plus silence and noise.
- `npm run icons` redraws `public/icons/*.png` and `public/favicon.svg` to match the tuner: the green arc and a white pixel E on the screen band.

## Dependency rule

`.npmrc` sets `min-release-age=4`: npm won't install any package version, direct or transitive, published less than 4 days ago. Tools from outside npm (like `cloudflared` from Homebrew) get their release date checked by hand before install.
