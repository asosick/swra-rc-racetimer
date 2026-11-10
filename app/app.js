'use strict';

/* ------------------------------------------------------------------ *
 * Race definitions (from the SWRA 2-pole criteria doc)
 * ------------------------------------------------------------------ */
const RACES = {
  bronze10: { name: 'Bronze 10', total: 150, lap: 15 },
  bronze8:  { name: 'Bronze 8',  total: 120, lap: 15 },
  silver:   { name: 'Silver',    total: 120, lap: 12 },
  gold:     { name: 'Gold',      total: 90,  lap: 9  },
};
const COUNTDOWN = 10;      // seconds before the race clock starts
const LOOKAHEAD = 1.5;     // seconds of audio scheduled ahead of the clock
const SPEAK_DELAY = 0.22;  // seconds after a lap beep starts before the lap number is spoken

/* ------------------------------------------------------------------ *
 * Settings (remembered on this device)
 * ------------------------------------------------------------------ */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let raceKey = store.get('raceKey', 'bronze10');
if (!RACES[raceKey]) raceKey = 'bronze10';
let lapSoundsOn = store.get('lapSounds', true);

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */
let ctx = null;
let master = null;
let liveNodes = [];

function audio() {
  if (!ctx) {
    // iOS: play through the ringer/silent switch like a media app would.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}

/** Schedule one tone at absolute AudioContext time t. */
function tone(t, freq, dur, { type = 'square', gain = 0.35, slideTo = null, vibrato = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  let lfo = null;
  if (vibrato) {
    lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 7;
    lg.gain.value = vibrato;
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  const a = 0.008, r = Math.min(0.06, dur / 3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + a);
  g.gain.setValueAtTime(gain, t + dur - r);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
  liveNodes.push(o); if (lfo) liveNodes.push(lfo);
  o.onended = () => { liveNodes = liveNodes.filter(n => n !== o && n !== lfo); };
}

const SOUNDS = {
  // Countdown tick each second; last three are higher so pilots know it's close.
  tick(t, n) { n <= 3 ? tone(t, 1320, 0.16, { gain: 0.4 }) : tone(t, 880, 0.1, { gain: 0.3 }); },
  // Race start.
  go(t) { tone(t, 1760, 0.7, { gain: 0.45 }); },
  // Short lap tone.
  lap(t) { tone(t, 2093, 0.18, { gain: 0.45 }); },
  // End of race: quick rising triple, then a long warbling horn.
  end(t) {
    tone(t,        1047, 0.12, { gain: 0.4 });
    tone(t + 0.14, 1319, 0.12, { gain: 0.4 });
    tone(t + 0.28, 1568, 0.12, { gain: 0.4 });
    tone(t + 0.45, 880, 2.6, { type: 'sawtooth', gain: 0.4, vibrato: 40 });
    tone(t + 0.45, 1320, 2.6, { type: 'square', gain: 0.18, vibrato: 60 });
  },
};

function silenceAll() {
  for (const n of liveNodes) { try { n.stop(); } catch {} }
  liveNodes = [];
}

/* ------------------------------------------------------------------ *
 * Voice (lap number spoken right after the short beep)
 * ------------------------------------------------------------------ */
const synth = window.speechSynthesis || null;
let voice = null;
function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices();
  voice = vs.find(v => /en[-_]US/i.test(v.lang) && v.localService) || vs.find(v => /^en/i.test(v.lang)) || null;
}
if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }

function speak(text, volume = 1) {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-US';
  u.rate = 1.15; u.volume = volume;
  synth.cancel();
  synth.speak(u);
}

/* ------------------------------------------------------------------ *
 * Keep the screen awake during a race
 * ------------------------------------------------------------------ */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (phase === 'countdown' || phase === 'racing')) keepAwake(true);
});

/* ------------------------------------------------------------------ *
 * Race engine
 *   All timing is driven by the AudioContext clock, so beeps land on
 *   the exact second even if the UI thread hiccups.
 * ------------------------------------------------------------------ */
let phase = 'idle';           // idle | countdown | racing | finished
let t0 = 0;                   // AudioContext time the race clock hits 0:00
let events = [];              // { t, kind, n, scheduled, spoken }
let schedTimer = null;
let rafId = null;

function buildEvents(race, startAt) {
  const ev = [];
  for (let i = 0; i < COUNTDOWN; i++) ev.push({ t: startAt + i, kind: 'tick', n: COUNTDOWN - i });
  const go = startAt + COUNTDOWN;
  ev.push({ t: go, kind: 'go' });
  const laps = Math.round(race.total / race.lap);
  for (let k = 1; k < laps; k++) ev.push({ t: go + k * race.lap, kind: 'lap', n: k });
  ev.push({ t: go + race.total, kind: 'end', n: laps });
  return ev;
}

function scheduler() {
  const now = ctx.currentTime;
  for (const e of events) {
    if (!e.scheduled && e.t - now < LOOKAHEAD) {
      e.scheduled = true;
      if (e.t < now - 0.25) continue;      // too late (e.g. tab was suspended) — skip rather than play late
      if (e.kind === 'lap') {
        // Lap sounds can be toggled mid-race; decide at schedule time.
        e.audible = lapSoundsOn;
        if (e.audible) SOUNDS.lap(e.t);
      } else {
        SOUNDS[e.kind](e.t, e.n);
      }
    }
    if (e.kind === 'lap' && e.audible && !e.spoken && now >= e.t + SPEAK_DELAY) {
      e.spoken = true;
      if (lapSoundsOn && now < e.t + 2) speak(`Lap ${e.n}`);
    }
    // Spoken countdown: "10, 9, … 1, Go" on top of the countdown beeps.
    // Speech engines take ~0.1–0.3 s to start, so the voice lands just after each beep.
    if ((e.kind === 'tick' || e.kind === 'go') && !e.spoken && now >= e.t) {
      e.spoken = true;
      if (now < e.t + 0.5) speak(e.kind === 'go' ? 'Go!' : String(e.n));
    }
  }
  if (phase === 'racing' && now >= t0 + RACES[raceKey].total) finish();
}

function start() {
  audio();
  speak(' ', 0);  // unlock speech on iOS while we're still inside the tap
  const race = RACES[raceKey];
  const startAt = ctx.currentTime + 0.15;
  t0 = startAt + COUNTDOWN;
  events = buildEvents(race, startAt);
  setPhase('countdown');
  keepAwake(true);
  schedTimer = setInterval(scheduler, 25);
  scheduler();
  loop();
}

function finish() {
  setPhase('finished');
  clearInterval(schedTimer); schedTimer = null;
  keepAwake(false);
  render();
  cancelAnimationFrame(rafId);
}

function reset() {
  clearInterval(schedTimer); schedTimer = null;
  cancelAnimationFrame(rafId);
  silenceAll();
  if (synth) synth.cancel();
  events = [];
  keepAwake(false);
  setPhase('idle');
  render();
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const app = document.querySelector('.app');
const el = {
  types: $('raceTypes'), lapSounds: $('lapSounds'), status: $('status'), big: $('big'), sub: $('sub'),
  lapFill: $('lapFill'), remaining: $('remaining'), elapsed: $('elapsed'), main: $('mainBtn'), test: $('testBtn'),
};

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

function setPhase(p) {
  phase = p;
  app.dataset.phase = p;
  el.main.textContent = { idle: 'Start', countdown: 'Stop', racing: 'Stop', finished: 'Reset' }[p];
  for (const b of el.types.children) b.disabled = (p === 'countdown' || p === 'racing');
}

let lastBig = null;
function setBig(v) {
  const s = String(v);
  if (s === lastBig) return;
  lastBig = s;
  el.big.textContent = s;
  el.big.classList.remove('pulse'); void el.big.offsetWidth; el.big.classList.add('pulse');
}

function render() {
  const race = RACES[raceKey];
  const laps = Math.round(race.total / race.lap);
  const now = ctx ? ctx.currentTime : 0;

  if (phase === 'idle') {
    el.status.textContent = 'Ready';
    setBig(0);
    el.sub.textContent = `of ${laps} laps · ${race.lap}s per lap`;
    el.lapFill.style.width = '0%';
    el.remaining.textContent = fmt(race.total);
    el.elapsed.textContent = fmt(0);
    return;
  }

  if (phase === 'countdown') {
    const left = t0 - now;
    if (left <= 0) { setPhase('racing'); return render(); }
    el.status.textContent = 'Get ready';
    setBig(Math.ceil(left));
    el.sub.textContent = `${race.name} starts in`;
    el.lapFill.style.width = `${(1 - left / COUNTDOWN) * 100}%`;
    el.remaining.textContent = fmt(race.total);
    el.elapsed.textContent = fmt(0);
    return;
  }

  const elapsed = Math.min(race.total, now - t0);
  const done = Math.min(laps, Math.floor(elapsed / race.lap + 1e-6));
  if (phase === 'finished') {
    el.status.textContent = 'Finish';
    setBig(laps);
    el.sub.textContent = `${race.name} complete`;
    el.lapFill.style.width = '100%';
    el.remaining.textContent = fmt(0);
    el.elapsed.textContent = fmt(race.total);
    return;
  }
  el.status.textContent = 'Racing';
  setBig(done);
  el.sub.textContent = `of ${laps} laps`;
  el.lapFill.style.width = `${((elapsed % race.lap) / race.lap) * 100}%`;
  el.remaining.textContent = fmt(race.total - elapsed);
  el.elapsed.textContent = fmt(elapsed);
}

function loop() {
  render();
  if (phase === 'countdown' || phase === 'racing') rafId = requestAnimationFrame(loop);
}

function buildRaceButtons() {
  el.types.innerHTML = '';
  for (const [key, r] of Object.entries(RACES)) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(key === raceKey));
    b.dataset.key = key;
    b.innerHTML = `${r.name}<small>${r.total}s / ${r.lap}s</small>`;
    b.addEventListener('click', () => {
      if (phase === 'countdown' || phase === 'racing') return;
      raceKey = key; store.set('raceKey', key);
      for (const c of el.types.children) c.setAttribute('aria-checked', String(c.dataset.key === key));
      if (phase === 'finished') setPhase('idle');
      render();
    });
    el.types.appendChild(b);
  }
}

function syncLapToggle() { el.lapSounds.setAttribute('aria-checked', String(lapSoundsOn)); }

el.lapSounds.addEventListener('click', () => {
  lapSoundsOn = !lapSoundsOn; store.set('lapSounds', lapSoundsOn); syncLapToggle();
  if (!lapSoundsOn && synth) synth.cancel();
});

el.main.addEventListener('click', () => {
  if (phase === 'idle') start();
  else reset();
});

el.test.addEventListener('click', () => {
  audio();
  const t = ctx.currentTime + 0.1;
  SOUNDS.tick(t, 5); SOUNDS.tick(t + 0.5, 2); SOUNDS.go(t + 1);
  SOUNDS.lap(t + 2.2);
  setTimeout(() => speak('Lap 1'), (2.2 + SPEAK_DELAY) * 1000);
  SOUNDS.end(t + 3.4);
});

buildRaceButtons();
syncLapToggle();
setPhase('idle');
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
