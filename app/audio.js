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

export function initAudio() {
  if (ctx) return ctx;
  // iOS: play through the ringer/silent switch like a media app.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = settings.volume;
  voiceBus = ctx.createGain();
  voiceBus.gain.value = 1;
  voiceBus.connect(master);
  master.connect(comp).connect(ctx.destination);
  voiceReady = loadVoiceSet(settings.voice);
  return ctx;
}

/** Call from inside a tap so mobile browsers allow sound. */
export function unlockAudio() {
  initAudio();
  if (ctx.state !== 'running') ctx.resume();
  unlockSpeech();
}

export function setVolume(v) {
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

export function silenceAll() {
  for (const n of live) { try { n.stop(); } catch {} }
  live = [];
  if (synth) synth.cancel();
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

let shaper = null;
function distortion() {
  if (shaper) return shaper;
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(3 * x); }
  shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

/** Stadium air horn: a raspy, slightly dissonant cluster that "blooms" in pitch. */
function airHorn(t, dur, gain = 0.5) {
  const end = t + dur;
  const pre = ctx.createGain(); pre.gain.value = 0.55;
  const shape = ctx.createWaveShaper(); shape.curve = distortion().curve; shape.oversample = '4x';
  const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 2400; bp.Q.value = 0.9; bp.gain.value = 6;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  amp.gain.setValueAtTime(gain, end - 0.09);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  pre.connect(shape).connect(bp).connect(lp).connect(amp).connect(master);
  for (const f of [349, 415, 466, 523]) {
    for (const det of [-7, 7]) {
      const o = osc('sawtooth', f * 0.9, t, end + 0.05);
      o.detune.value = det;
      o.frequency.exponentialRampToValueAtTime(f, t + 0.06);     // bloom up into pitch
      o.frequency.setValueAtTime(f, end - 0.12);
      o.frequency.exponentialRampToValueAtTime(f * 0.96, end);  // little droop at the end
      const g = ctx.createGain(); g.gain.value = 0.18;
      o.connect(g).connect(pre);
    }
  }
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
  // Race start: air horn.
  go(t) { airHorn(t, 0.85); },
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
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = !VOICE_SETS[settings.voice] && synth.getVoices().find(x => x.voiceURI === settings.voice);
  const fallback = deviceVoices().find(x => /en[-_]US/i.test(x.lang) && x.localService) || deviceVoices()[0];
  const voice = v || fallback;
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-US';
  u.rate = settings.rate;
  u.volume = settings.volume;
  synth.cancel();
  synth.speak(u);
}

/** Say a phrase right now. phrase = { keys: [...clip keys], text: 'fallback text' } */
export function sayNow(phrase) {
  if (canUseClips(phrase.keys)) playClips(phrase.keys, ctx.currentTime + 0.02);
  else speakText(phrase.text);
}
