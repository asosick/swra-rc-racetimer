# SWRA Race Timer

Timer for SWRA 2-pole races, built as an installable web app (PWA). It runs in the phone's browser, works offline once loaded, and plays through whatever speaker the phone is connected to (including Bluetooth).

## Races

| Race      | Length | Lap tone every | Laps |
|-----------|--------|----------------|------|
| Bronze 10 | 150 s  | 15 s           | 10   |
| Bronze 8  | 120 s  | 15 s           | 8    |
| Silver    | 120 s  | 12 s           | 10   |
| Gold      | 90 s   | 9 s            | 10   |

**Start** runs a countdown (10 s by default): a beep and a spoken number each second, then "Go!" with a long tone. With **Lap sounds** on, each lap plays a short beep and then "Lap 1", "Lap 2"… The last lap is called as "Final lap". The race ends with a rising three-note chirp and a long warbling horn.

During a race:

- **Pause / Resume**: pause freezes the clock and says "Race paused". Resume plays a 3-2-1-go lead-in, then the race continues where it stopped.
- **Hold Stop** (about 1 second) to end the race and reset to zero. A quick tap does nothing, so a race can't be stopped by accident.
- The screen shows the lap count, time remaining, time to the next lap, and time elapsed.

Other features:

- **Heats**: queue up a run of heats (any mix of race types). Set a break between heats (30 s to 5 min) and the next heat starts on its own, announced as "Heat 3" before its countdown. You can also choose manual start.
- **Race log**: every finished or stopped race is saved on the phone. Share it as text or download it as CSV.
- **Settings**: volume, voice countdown on/off, time warnings ("One minute", "Thirty seconds") on/off, countdown length, recorded voice or the phone's own voice (with speed), a dark or sunlight (black-on-yellow) theme, and custom race types.

### Voice clips

Spoken callouts use the recorded clips in `app/voice/`, which are scheduled on the audio clock for exact timing. If a clip is missing, or a phone voice is picked in settings, the app falls back to the phone's text-to-speech.

The clips were generated with `tools/make-voice.sh` using a macOS system voice. Apple's licence for those voices is aimed at personal use, so before this goes wide it's worth recording a real person's voice instead. Record the same phrases, save them with the same file names, and you're done. The phrase list is in the script.

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

When you change files in `app/`, bump `VERSION` in `app/sw.js` so installed copies update. In the browser console, `__race.skip(30)` fast-forwards a running race by 30 seconds for testing.

## Deploy

`.github/workflows/pages.yml` publishes `app/` to GitHub Pages on every push to `main`. One-time setup: repo **Settings → Pages → Source: GitHub Actions**.
