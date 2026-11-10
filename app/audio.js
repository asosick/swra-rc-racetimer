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

/* ---------- tones ---------- */
function tone(t, freq, dur, { type = 'square', gain = 0.35, vibrato = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (vibrato) {
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 7;
    lg.gain.value = vibrato;
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t); lfo.stop(t + dur + 0.05);
    track(lfo);
  }
  const a = 0.008, r = Math.min(0.06, dur / 3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + a);
  g.gain.setValueAtTime(gain, t + dur - r);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
  track(o);
}

export const SOUNDS = {
  // Countdown tick each second; last three are higher.
  tick(t, n) { n <= 3 ? tone(t, 1320, 0.14, { gain: 0.4 }) : tone(t, 880, 0.1, { gain: 0.3 }); },
  // Race start.
  go(t) { tone(t, 1760, 0.6, { gain: 0.45 }); },
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
