# SWRA Race Timer

Timer for SWRA 2-pole races, built as an installable web app (PWA). It runs in the phone's browser, works offline once loaded, and plays through whatever speaker the phone is connected to (including Bluetooth).

## Races

| Race      | Length | Lap tone every | Laps |
|-----------|--------|----------------|------|
| Bronze 10 | 150 s  | 15 s           | 10   |
| Bronze 8  | 120 s  | 15 s           | 8    |
| Silver    | 120 s  | 12 s           | 10   |
| Gold      | 90 s   | 9 s            | 10   |

**Start** runs a 10-second countdown (beep each second, higher beeps for 3-2-1, long tone on GO), then the race clock. With **Lap sounds** on, each lap plays a short beep and then speaks the lap number. The race ends with a rising three-note chirp and a long warbling horn. **Stop** resets the timer and laps to zero.

## Install on a phone

Open the site, then:

- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** ⋮ menu → Install app (or Add to Home screen).

Pair the Bluetooth speaker in the phone's settings first; the app just plays to the current audio output. Use **Test sound** to check volume before a race.

## Develop

Everything is static files in `app/`. Serve it locally:

```bash
python3 -m http.server 8765 --directory app
```

When you change files in `app/`, bump `VERSION` in `app/sw.js` so installed copies update.

## Deploy

`.github/workflows/pages.yml` publishes `app/` to GitHub Pages on every push to `main`. One-time setup: repo **Settings → Pages → Source: GitHub Actions**.
