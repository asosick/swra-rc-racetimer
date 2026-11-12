// Tones and voice. Everything is scheduled on the AudioContext clock so it
// lands on the exact second even if the UI thread is busy.
import { settings } from './store.js';

export let ctx = null;
let master = null;
let voiceBus = null;
let live = [];

/* ---------- recorded voice clips (app/voice/<set>/*.m4a) ---------- */
export const VOICE_SETS = {
  liam: 'Liam (exciting)',
  classic: 'Classic (calm)',
};
export function clipKeys() {
  const keys = ['go', 'final', 'min1', 'sec30', 'paused'];
  for (let i = 1; i <= 20; i++) keys.push(`n${i}`, `heat${i}`);
  for (let i = 1; i <= 30; i++) keys.push(`lap${i}`);
  return keys;
}
const sets = new Map(); // set name -> { clips: Map, ready: Promise }

// Decode on an OfflineAudioContext: it isn't subject to autoplay rules, so the
// clips are ready before the first tap (iPhone stalls decoding on a suspended
// AudioContext). The resulting AudioBuffers play fine in the real context.
let decoder = null;
function decode(ab) {
  if (!decoder) {
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try { decoder = Off ? new Off(1, 1, 44100) : null; } catch { decoder = null; }
  }
  const dc = decoder || ctx;
  return new Promise((resolve, reject) => {
    const p = dc.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}
/** Load (once) a recorded voice set. Resolves when all its clips are decoded. */
export function loadVoiceSet(name) {
  if (!VOICE_SETS[name]) return Promise.resolve();
  if (!sets.has(name)) {
    const clips = new Map();
    const ready = Promise.all(clipKeys().map(async key => {
      try {
        const res = await fetch(`voice/${name}/${key}.m4a`);
        if (!res.ok) return;
        clips.set(key, await decode(await res.arrayBuffer()));
      } catch {}
    }));
    const entry = { clips, ready, done: false };
    ready.then(() => { entry.done = true; window.__log?.(`voice ${name}: ${clips.size} clips`); });
    sets.set(name, entry);
  }
  return sets.get(name).ready;
}
const currentClips = () => sets.get(settings.voice)?.clips;
export let voiceReady = Promise.resolve();

const stateListeners = new Set();
/** Be told when the audio engine starts/stops running (iOS can interrupt it). */
export function onAudioState(fn) { stateListeners.add(fn); }

function buildContext() {
  const old = ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  window.__ctx = ctx;
  ctx.addEventListener?.('statechange', () => {
    window.__log?.('ctx -> ' + ctx.state);
    stateListeners.forEach(fn => fn(ctx.state));
  });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = settings.volume;
  voiceBus = ctx.createGain();
  voiceBus.gain.value = 1;
  voiceBus.connect(master);
  master.connect(comp).connect(ctx.destination);
  live = [];
  if (old && old.state !== 'closed') { try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch {} }
}

export function initAudio() {
  if (ctx) return ctx;
  // iOS: play through the ringer/silent switch like a media app.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  buildContext();
  voiceReady = Promise.all([loadVoiceSet(settings.voice), loadSamples()]);
  return ctx;
}

/**
 * Call from inside a tap so mobile browsers allow sound.
 * fresh=true (only when nothing is scheduled, e.g. on Start): if iOS has left the
 * engine "interrupted" (calls, Siri, other apps), replace it so the clock runs again.
 * Decoded clips are plain AudioBuffers and carry over to the new engine.
 */
export function unlockAudio({ fresh = false } = {}) {
  initAudio();
  if (fresh && (ctx.state === 'interrupted' || ctx.state === 'closed')) {
    window.__log?.('rebuilding audio engine (was ' + ctx.state + ')');
    buildContext();
  }
  if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }

}

/** Resolves once the audio engine is running (or after `ms`). */
export function audioRunning(ms = 600) {
  if (ctx && ctx.state === 'running') return Promise.resolve(true);
  return new Promise(resolve => {
    const t0 = performance.now();
    const check = () => {
      if (ctx && ctx.state === 'running') return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(check, 30);
    };
    check();
  });
}

export function setVolume(v) {
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

export function silenceAll() {
  for (const n of live) { try { n.stop(); } catch {} }
  live = [];
}

function track(node) {
  live.push(node);
  node.onended = () => { live = live.filter(n => n !== node); };
}

/* ---------- sound design ----------
 * All synthesized (no sample files): rounded bell/marimba tones instead of raw
 * square waves, an air horn for the start, and a brass fanfare for the finish.
 */
function osc(type, freq, t, stopAt) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t); o.stop(stopAt);
  track(o);
  return o;
}

/** Struck tone: fast attack, exponential decay; upper partials die away sooner. */
function bell(t, freq, dur, gain, partials = [[1, 1], [2, 0.3], [3, 0.12]]) {
  for (const [ratio, amp] of partials) {
    const d = dur / Math.sqrt(ratio);
    const o = osc('sine', freq * ratio, t, t + d + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain * amp, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(master);
  }
}

/* Sampled sounds (app/sounds/). Air horn: "Gas fog horn #2" by Joseph Sardin,
 * BigSoundBank, CC0 — https://bigsoundbank.com/gas-fog-horn-2-s1049.html */
const samples = new Map();
async function loadSamples() {
  await Promise.all(['airhorn'].map(async name => {
    try {
      const res = await fetch(`sounds/${name}.m4a`);
      if (res.ok) samples.set(name, await decode(await res.arrayBuffer()));
    } catch {}
  }));
}
function playSample(name, t, gain = 1) {
  const buf = samples.get(name);
  if (!buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(g).connect(master);
  src.start(t);
  track(src);
  return true;
}

/** Warm brass: detuned saws through an opening low-pass filter, vibrato on long notes. */
function brass(t, freqs, dur, gain = 0.32) {
  const end = t + dur;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(3200, t + 0.05);
  lp.frequency.exponentialRampToValueAtTime(1900, t + Math.min(0.5, dur * 0.6));
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.03);
  amp.gain.setValueAtTime(gain * 0.85, end - Math.min(0.25, dur / 3));
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  lp.connect(amp).connect(master);
  let lfoGain = null;
  if (dur > 0.6) {
    const lfo = osc('sine', 5.5, t, end + 0.05);
    lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.linearRampToValueAtTime(14, t + 0.5); // cents of vibrato, fading in
    lfo.connect(lfoGain);
  }
  for (const f of freqs) {
    for (const det of [-6, 6]) {
      const o = osc('sawtooth', f, t, end + 0.05);
      o.detune.value = det;
      if (lfoGain) lfoGain.connect(o.detune);
      const g = ctx.createGain(); g.gain.value = 0.22 / freqs.length;
      o.connect(g).connect(lp);
    }
  }
}

export const SOUNDS = {
  // Countdown: soft marimba "tok" each second; 3-2-1 are a brighter bell.
  tick(t, n) {
    if (n <= 3) bell(t, 1568, 0.45, 0.6);
    else bell(t, 1047, 0.22, 0.55, [[1, 1], [3.93, 0.18]]);
  },
  // Race start: air horn (falls back to a bright bell chord if the clip didn't load).
  go(t) {
    if (playSample('airhorn', t, 0.9)) return;
    for (const f of [1047, 1319, 1568]) bell(t, f, 0.7, 0.35);
  },
  // Lap: quick two-note chime ("di-ding").
  lap(t) {
    bell(t, 1760, 0.18, 0.5);
    bell(t + 0.07, 2349, 0.4, 0.55);
  },
  // Finish: the air horn sounds exactly at time-up (so a close finish is easy
  // to call), then the brass fanfare — da-da-da-DAAA — once the horn is done.
  end(t) {
    let f = t;
    if (playSample('airhorn', t, 0.9)) f = t + samples.get('airhorn').duration + 0.1;
    brass(f,        [392], 0.13);
    brass(f + 0.15, [523], 0.13);
    brass(f + 0.30, [659], 0.13);
    brass(f + 0.48, [523, 659, 784, 1047], 2.2, 0.36);
  },
};

/* ---------- voice: recorded clips only ----------
 * The phone's own text-to-speech is not used at all: on iPhone it interrupts
 * the audio engine (which is also the race clock). If a clip is missing, that
 * callout is simply skipped.
 */

/** True if every clip for this phrase is loaded in the current voice set. */
export function canUseClips(keys) {
  const clips = currentClips();
  return !!clips && keys.every(k => clips.has(k));
}
/** True once the current voice set has finished loading (even if some clips failed). */
export function voiceSetLoaded() { return !!sets.get(settings.voice)?.done; }

/** Schedule recorded clips back to back starting at time t (missing ones are skipped). */
export function playClips(keys, t) {
  const clips = currentClips();
  window.__log?.(`clips ${keys.join('+')} at +${(t - ctx.currentTime).toFixed(2)} ctx=${ctx.state} loaded=${clips ? clips.size : 0}`);
  if (!clips) return;
  let at = t;
  for (const k of keys) {
    const buf = clips.get(k);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(voiceBus);
    src.start(at);
    track(src);
    at += buf.duration + 0.06;
  }
}

/** Say a phrase right now. phrase = { keys: [...clip keys] } */
export function sayNow(phrase) {
  playClips(phrase.keys, ctx.currentTime + 0.03);
}
