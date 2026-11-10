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

function decode(ab) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
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
    sets.set(name, { clips, ready });
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
  // Only wake text-to-speech if a phone voice is in use: on iPhone it can
  // interrupt the audio engine, which freezes the race clock.
  if (!VOICE_SETS[settings.voice]) unlockSpeech();
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
  if (synth && (synth.speaking || synth.pending)) synth.cancel();
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
  // Finish: brass fanfare — da-da-da-DAAA.
  end(t) {
    brass(t,        [392], 0.13);
    brass(t + 0.15, [523], 0.13);
    brass(t + 0.30, [659], 0.13);
    brass(t + 0.48, [523, 659, 784, 1047], 2.2, 0.36);
  },
};

/* ---------- voice ---------- */
const synth = window.speechSynthesis || null;

export function deviceVoices() {
  if (!synth) return [];
  return synth.getVoices().filter(v => /^en/i.test(v.lang));
}
export function onVoicesChanged(fn) { if (synth) synth.addEventListener?.('voiceschanged', fn); }

function unlockSpeech() {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}

/** True if this phrase will be played from recorded clips (sample-accurate). */
export function canUseClips(keys) {
  const clips = currentClips();
  return !!clips && keys.every(k => clips.has(k));
}

/** Schedule recorded clips back to back starting at time t. */
export function playClips(keys, t) {
  window.__log?.(`clips ${keys.join('+')} at +${(t - ctx.currentTime).toFixed(2)} ctx=${ctx.state}`);
  const clips = currentClips();
  let at = t;
  for (const k of keys) {
    const buf = clips.get(k);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(voiceBus);
    src.start(at);
    track(src);
    at += buf.duration + 0.06;
  }
}

/** Speak with the phone's text-to-speech (fallback, or when chosen in settings). */
export function speakText(text) {
  window.__log?.(`tts "${text}" synth=${!!synth} speaking=${synth?.speaking} pending=${synth?.pending}`);
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = !VOICE_SETS[settings.voice] && synth.getVoices().find(x => x.voiceURI === settings.voice);
  const fallback = deviceVoices().find(x => /en[-_]US/i.test(x.lang) && x.localService) || deviceVoices()[0];
  const voice = v || fallback;
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-US';
  u.rate = settings.rate;
  u.volume = settings.volume;
  // iOS ignores speak() straight after cancel(); give it a moment.
  if (synth.speaking || synth.pending) { synth.cancel(); setTimeout(() => synth.speak(u), 60); }
  else synth.speak(u);
}

/** Say a phrase right now. phrase = { keys: [...clip keys], text: 'fallback text' } */
export function sayNow(phrase) {
  window.__log?.(`sayNow ${phrase.keys} canClips=${canUseClips(phrase.keys)} voice=${settings.voice}`);
  if (canUseClips(phrase.keys)) playClips(phrase.keys, ctx.currentTime + 0.02);
  else speakText(phrase.text);
}
