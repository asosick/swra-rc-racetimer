import {
  APP_VERSION, BUILTIN_RACES, settings, save, allRaces, getRace, lapCount,
  addCustomRace, deleteCustomRace, getLog, addLog, clearLog,
} from './store.js';
import {
  ctx, initAudio, unlockAudio, setVolume, silenceAll, SOUNDS,
  canUseClips, playClips, speakText, sayNow, deviceVoices, onVoicesChanged,
  VOICE_SETS, loadVoiceSet, voiceReady,
} from './audio.js';

const LOOKAHEAD = 1.5;      // seconds of audio scheduled ahead of the clock
const LAP_VOICE_DELAY = 0.22;   // lap number follows the short lap beep
const COUNT_VOICE_DELAY = 0.15; // countdown number follows the tick
const HEAT_ANNOUNCE = 1.3;  // "Heat 3" is said this long before the countdown starts
const RESUME_LEAD = 3;      // 3-2-1-go before a paused race restarts
const HOLD_MS = 800;        // hold Stop this long to stop a race
const WARNINGS = [[60, 'min1', 'One minute'], [30, 'sec30', 'Thirty seconds']];

/* ================================================================== *
 * State
 * ================================================================== */
// phase: idle | countdown | racing | paused | resuming | finished | gap
let phase = 'idle';
let events = [];
let t0 = 0;            // AudioContext time the race clock reads 0:00
let t1 = 0;            // resume "go" time (phase 'resuming')
let pausedAt = 0;      // race-clock freeze point while paused
let pausedFrom = null; // 'countdown' | 'racing'
let pauseCount = 0;
let gapEnd = 0;
let activeRace = null; // race being run (fixed for the duration)
let ticker = null;
let rafId = null;

// Heat sequence (not persisted across reloads; the heat list is).
const seq = { active: false, index: 0 };

const isRunning = () => ['countdown', 'racing', 'paused', 'resuming'].includes(phase);
const now = () => ctx.currentTime;

function currentRace() {
  if (seq.active) return getRace(settings.heats[seq.index]);
  return getRace(settings.raceId);
}

/* ================================================================== *
 * Event building
 *   Sound events: { t, sound, n, cond }
 *   Voice events: { t, voice: true, parts: [{ keys, text, cond }] }
 *   cond: 'lap' | 'count' | 'warn' | undefined (always)
 * ================================================================== */
function enabled(cond) {
  if (cond === 'lap') return settings.lapSounds;
  if (cond === 'count') return settings.voiceCountdown;
  if (cond === 'warn') return settings.warnings;
  return true;
}
const sound = (t, s, n, cond, extra = {}) => ({ t, sound: s, n, cond, ...extra });
const voice = (t, parts, extra = {}) => ({ t, voice: true, parts, ...extra });

function countdownEvents(startAt, count, extra = {}) {
  const ev = [];
  for (let i = 0; i < count; i++) {
    const n = count - i, t = startAt + i;
    ev.push(sound(t, 'tick', n, undefined, extra));
    ev.push(voice(t + COUNT_VOICE_DELAY, [{ keys: [`n${n}`], text: String(n), cond: 'count' }], extra));
  }
  const go = startAt + count;
  ev.push(sound(go, 'go', 0, undefined, extra));
  ev.push(voice(go, [{ keys: ['go'], text: 'Go!', cond: 'count' }], extra));
  return ev;
}

function raceEvents(race, go) {
  const ev = [];
  const laps = lapCount(race);
  for (let k = 1; k < laps; k++) {
    const t = go + k * race.lap;
    const final = k === laps - 1 && laps > 1;
    ev.push(sound(t, 'lap', k, 'lap'));
    ev.push(voice(t + LAP_VOICE_DELAY, [final
      ? { keys: ['final'], text: 'Final lap', cond: 'lap' }
      : { keys: [`lap${k}`], text: `Lap ${k}`, cond: 'lap' }]));
  }
  ev.push(sound(go + race.total, 'end', laps));
  // Time warnings: tack onto a lap callout if they coincide, otherwise stand alone.
  for (const [left, key, text] of WARNINGS) {
    if (race.total - left < 5) continue;
    const wt = go + race.total - left;
    const part = { keys: [key], text, cond: 'warn' };
    const near = ev.find(e => e.voice && Math.abs(e.t - (wt + LAP_VOICE_DELAY)) < 1);
    if (near) near.parts.push(part); else ev.push(voice(wt, [part]));
  }
  return ev;
}

/* ================================================================== *
 * Scheduler
 * ================================================================== */
function tick() {
  if (!ctx) return;
  const n = now();
  if (phase !== 'paused' && phase !== 'gap') {
    for (const e of events) {
      if (e.done || e.t - n > LOOKAHEAD) continue;
      if (e.voice) {
        if (!e.resolved) {
          e.resolved = true;
          e.active = e.parts.filter(p => enabled(p.cond));
          const keys = e.active.flatMap(p => p.keys);
          if (!e.active.length || e.t < n - 0.3) { e.done = true; continue; }
          if (canUseClips(keys)) { playClips(keys, e.t); e.done = true; continue; }
        }
        if (n >= e.t) { // text-to-speech fallback fires on time
          e.done = true;
          if (n < e.t + 1) speakText(e.active.map(p => p.text).join(', '));
        }
      } else {
        e.done = true;
        if (e.t < n - 0.25) continue; // too late (tab was asleep) — skip rather than play late
        if (e.cond && !enabled(e.cond)) continue;
        SOUNDS[e.sound](e.t, e.n);
      }
    }
  }
  if (phase === 'countdown' && n >= t0) setPhase('racing');
  if (phase === 'resuming' && n >= t1) setPhase('racing');
  if (phase === 'racing' && n >= t0 + activeRace.total) finish();
  if (phase === 'gap' && n >= gapEnd) start();
}

function startTicker() {
  if (!ticker) ticker = setInterval(tick, 25);
  if (!rafId) loop();
}
function stopTicker() {
  clearInterval(ticker); ticker = null;
}

/* ================================================================== *
 * Race control
 * ================================================================== */
function start() {
  unlockAudio();
  activeRace = currentRace();
  let startAt = now() + 0.15;
  events = [];
  if (seq.active) {
    const h = seq.index + 1;
    events.push(voice(startAt, [{ keys: [`heat${h}`], text: `Heat ${h}` }]));
    startAt += HEAT_ANNOUNCE;
  }
  const C = settings.countdown;
  t0 = startAt + C;
  events.push(...countdownEvents(startAt, C), ...raceEvents(activeRace, t0));
  pauseCount = 0;
  setPhase('countdown');
  keepAwake(true);
  startTicker();
  tick();
}

function pause() {
  if (!['countdown', 'racing', 'resuming'].includes(phase)) return;
  pausedFrom = phase === 'countdown' ? 'countdown' : 'racing';
  pausedAt = phase === 'resuming' ? t1 : now();
  silenceAll();
  events = events.filter(e => !e.resumeOnly);
  for (const e of events) if (e.t > pausedAt - 0.02) { e.done = false; e.resolved = false; }
  pauseCount++;
  setPhase('paused');
  sayNow({ keys: ['paused'], text: 'Race paused' });
}

function resume() {
  if (phase !== 'paused') return;
  unlockAudio();
  const n = now();
  let goAt;
  if (pausedFrom === 'countdown') {
    goAt = n + 0.3;
  } else {
    const lead = n + 0.2;
    goAt = lead + RESUME_LEAD;
    events.push(...countdownEvents(lead, RESUME_LEAD, { resumeOnly: true }));
  }
  const shift = goAt - pausedAt;
  for (const e of events) if (!e.resumeOnly && e.t > pausedAt - 0.02) e.t += shift;
  t0 += shift;
  t1 = goAt;
  setPhase(pausedFrom === 'countdown' ? 'countdown' : 'resuming');
  tick();
}

function raceClock() {
  if (phase === 'paused') return pausedAt;
  if (phase === 'resuming') return t1;
  return now();
}

function logRace(result) {
  const r = activeRace;
  const laps = lapCount(r);
  const elapsed = Math.max(0, Math.min(r.total, raceClock() - t0));
  addLog({
    race: r.name, total: r.total, lap: r.lap, result,
    elapsed: Math.round(elapsed * 10) / 10,
    laps: result === 'finished' ? laps : Math.min(laps, Math.floor(elapsed / r.lap + 1e-6)),
    of: laps,
    heat: seq.active ? `${seq.index + 1}/${settings.heats.length}` : null,
    pauses: pauseCount,
  });
}

function finish() {
  logRace('finished');
  const more = seq.active && seq.index < settings.heats.length - 1;
  if (more && settings.heatGap > 0) {
    seq.index++;
    gapEnd = now() + settings.heatGap;
    events = [];
    setPhase('gap');
  } else {
    stopTicker();
    keepAwake(false);
    setPhase('finished');
  }
}

/** Stop button / reset: back to idle, timer and laps to zero. */
function stop() {
  if (phase === 'racing' || phase === 'resuming' || (phase === 'paused' && pausedFrom === 'racing')) logRace('stopped');
  stopTicker();
  silenceAll();
  events = [];
  keepAwake(seq.active);
  setPhase('idle');
}

function nextFromFinished() {
  if (seq.active) {
    if (seq.index < settings.heats.length - 1) seq.index++;
    else endSequence();
  }
  setPhase('idle');
}

/* ---------- heat sequence ---------- */
function startSequence() {
  if (!settings.heats.length || isRunning()) return;
  seq.active = true; seq.index = 0;
  setPhase('idle');
}
function endSequence() {
  seq.active = false; seq.index = 0;
  if (phase === 'gap') { stopTicker(); setPhase('idle'); }
  keepAwake(false);
  refreshAll();
}

/* ================================================================== *
 * Screen wake lock
 * ================================================================== */
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
  if (document.visibilityState === 'visible' && (isRunning() || phase === 'gap' || seq.active)) keepAwake(true);
});

/* ================================================================== *
 * UI
 * ================================================================== */
const $ = id => document.getElementById(id);
const app = document.querySelector('.app');
const el = {
  types: $('raceTypes'), lapSounds: $('lapSounds'), banner: $('heatBanner'), status: $('status'),
  big: $('big'), sub: $('sub'), lapFill: $('lapFill'), remaining: $('remaining'), nextLap: $('nextLap'),
  elapsed: $('elapsed'), main: $('mainBtn'), mainLabel: document.querySelector('.main-label'),
  second: $('secondBtn'), hint: $('hint'), test: $('testBtn'),
};

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
function fmtGap(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setPhase(p) {
  phase = p;
  app.dataset.phase = p;
  if (p === 'paused') app.dataset.pausedFrom = pausedFrom;
  const labels = {
    idle: 'Start', countdown: 'Stop', racing: 'Stop', paused: 'Stop', resuming: 'Stop',
    gap: 'Start now',
    finished: !seq.active ? 'Reset' : (seq.index < settings.heats.length - 1 ? 'Next heat' : 'Done'),
  };
  el.mainLabel.textContent = labels[p];
  el.main.classList.toggle('hold', isRunning());
  const second = { countdown: 'Pause', racing: 'Pause', resuming: 'Pause', paused: 'Resume', gap: 'Wait' }[p];
  el.second.hidden = !second;
  if (second) el.second.textContent = second;
  el.hint.innerHTML = isRunning() ? 'Hold <b>Stop</b> to end the race' : p === 'gap' ? '<b>Wait</b> cancels the auto-start' : '&nbsp;';
  const shown = (isRunning() || p === 'finished') && activeRace ? activeRace : currentRace();
  for (const b of el.types.children) {
    b.disabled = isRunning() || p === 'gap' || seq.active;
    b.setAttribute('aria-checked', String(b.dataset.id === shown.id));
  }
  const sel = el.types.querySelector('[aria-checked="true"]');
  if (sel) {
    // Keep the selected race visible when custom races make the picker scroll.
    const left = sel.offsetLeft - el.types.offsetLeft;
    const fits = left + sel.offsetWidth <= el.types.clientWidth;
    el.types.scrollLeft = fits ? 0 : left - 4;
  }
  render();
  if (!rafId) loop();
}

let lastBig = null;
function setBig(v, wide = false) {
  const s = String(v);
  el.big.classList.toggle('wide', wide || s.length > 3);
  if (s === lastBig) return;
  lastBig = s;
  el.big.textContent = s;
  el.big.classList.remove('pulse'); void el.big.offsetWidth; el.big.classList.add('pulse');
}

function render() {
  const race = isRunning() || phase === 'finished' ? activeRace : currentRace();
  const laps = lapCount(race);
  const n = ctx ? now() : 0;

  el.banner.hidden = !seq.active;
  if (seq.active) {
    const total = settings.heats.length;
    const next = settings.heats[seq.index + 1];
    el.banner.textContent = phase === 'gap'
      ? `Break · Heat ${seq.index} of ${total} done`
      : `Heat ${seq.index + 1} of ${total}` + (next && phase !== 'finished' ? ` · Up next: ${getRace(next).name}` : '');
  }

  const clockRow = (elapsed) => {
    el.remaining.textContent = fmt(race.total - elapsed);
    el.elapsed.textContent = fmt(elapsed);
    const nextBoundary = Math.min(race.total, (Math.floor(elapsed / race.lap + 1e-6) + 1) * race.lap);
    el.nextLap.textContent = Math.max(0, nextBoundary - elapsed).toFixed(1);
  };

  switch (phase) {
    case 'idle':
      el.status.textContent = seq.active ? 'Ready' : 'Ready';
      setBig(0);
      el.sub.textContent = `${race.name} · ${laps} laps · ${race.lap}s per lap`;
      el.lapFill.style.width = '0%';
      clockRow(0);
      return;

    case 'gap': {
      const left = gapEnd - n;
      el.status.textContent = 'Next heat in';
      setBig(fmtGap(left), true);
      el.sub.textContent = `Heat ${seq.index + 1} · ${race.name}`;
      el.lapFill.style.width = `${(1 - left / settings.heatGap) * 100}%`;
      clockRow(0);
      return;
    }

    case 'countdown': {
      const left = t0 - n;
      el.status.textContent = 'Get ready';
      setBig(Math.min(settings.countdown, Math.max(1, Math.ceil(left))));
      el.sub.textContent = `${race.name} starts in`;
      el.lapFill.style.width = `${Math.max(0, 1 - left / settings.countdown) * 100}%`;
      clockRow(0);
      return;
    }

    case 'paused':
      el.status.textContent = 'Paused';
      if (pausedFrom === 'countdown') {
        setBig(Math.ceil(t0 - pausedAt));
        el.sub.textContent = `${race.name} countdown paused`;
        clockRow(0);
      } else {
        const e = pausedAt - t0;
        setBig(Math.min(laps, Math.floor(e / race.lap + 1e-6)));
        el.sub.textContent = `of ${laps} laps · tap Resume to continue`;
        clockRow(e);
      }
      return;

    case 'resuming':
      el.status.textContent = 'Resuming';
      setBig(Math.max(1, Math.ceil(t1 - n)));
      el.sub.textContent = `${race.name} restarts in`;
      clockRow(t1 - t0);
      return;

    case 'finished':
      el.status.textContent = seq.active && seq.index === settings.heats.length - 1 ? 'Heats complete' : 'Finish';
      setBig(laps);
      el.sub.textContent = `${race.name} complete`;
      el.lapFill.style.width = '100%';
      clockRow(race.total);
      return;

    case 'racing': {
      const e = Math.min(race.total, n - t0);
      el.status.textContent = 'Racing';
      setBig(Math.min(laps, Math.floor(e / race.lap + 1e-6)));
      el.sub.textContent = `of ${laps} laps`;
      el.lapFill.style.width = `${((e % race.lap) / race.lap) * 100}%`;
      clockRow(e);
    }
  }
}

function loop() {
  render();
  if (['countdown', 'racing', 'resuming', 'gap'].includes(phase)) rafId = requestAnimationFrame(loop);
  else rafId = null;
}

/* ---------- race type buttons ---------- */
function buildRaceButtons() {
  el.types.innerHTML = '';
  for (const r of allRaces()) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(r.id === currentRace().id));
    b.dataset.id = r.id;
    b.innerHTML = `${esc(r.name)}<small>${r.total}s / ${r.lap}s</small>`;
    b.disabled = isRunning() || phase === 'gap' || seq.active;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      settings.raceId = r.id; save();
      if (phase === 'finished') setPhase('idle');
      buildRaceButtons(); render();
    });
    el.types.appendChild(b);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- lap sounds toggle ---------- */
function syncLapToggle() { el.lapSounds.setAttribute('aria-checked', String(settings.lapSounds)); }
el.lapSounds.addEventListener('click', () => {
  settings.lapSounds = !settings.lapSounds; save(); syncLapToggle();
});

/* ---------- main button: tap to start, hold to stop ---------- */
let holdTimer = null;
function cancelHold() {
  clearTimeout(holdTimer); holdTimer = null;
  el.main.classList.remove('holding');
}
// After a hold stops the race the button turns into Start while the finger is
// still down; swallow that same press so lifting it doesn't start a new race.
let swallowPress = false;
el.main.addEventListener('pointerdown', e => {
  swallowPress = false;
  if (!isRunning()) return;
  e.preventDefault();
  el.main.classList.add('holding');
  holdTimer = setTimeout(() => { cancelHold(); swallowPress = true; stop(); }, HOLD_MS);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => el.main.addEventListener(t, () => {
  if (holdTimer) {
    cancelHold();
    el.hint.classList.remove('flash'); void el.hint.offsetWidth; el.hint.classList.add('flash');
  }
}));
el.main.addEventListener('contextmenu', e => e.preventDefault());
el.main.addEventListener('click', () => {
  if (swallowPress) { swallowPress = false; return; }
  if (isRunning()) return; // handled by hold
  if (phase === 'idle' || phase === 'gap') start();
  else if (phase === 'finished') nextFromFinished();
});

el.second.addEventListener('click', () => {
  if (phase === 'paused') resume();
  else if (phase === 'gap') { stopTicker(); setPhase('idle'); }
  else pause();
});

el.test.addEventListener('click', () => {
  unlockAudio();
  const t = now() + 0.1;
  SOUNDS.tick(t, 5); SOUNDS.tick(t + 0.5, 2); SOUNDS.go(t + 1);
  SOUNDS.lap(t + 2.2);
  const p = { keys: ['lap1'], text: 'Lap 1' };
  if (canUseClips(p.keys)) playClips(p.keys, t + 2.2 + LAP_VOICE_DELAY);
  else setTimeout(() => speakText(p.text), (2.2 + LAP_VOICE_DELAY) * 1000);
  SOUNDS.end(t + 3.4);
});

/* ================================================================== *
 * Sheets
 * ================================================================== */
function openSheet(id) { const d = $(id); if (!d.open) d.showModal(); }
for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); }); // tap backdrop to close
}
$('openSettings').addEventListener('click', () => { syncSettings(); openSheet('settingsSheet'); });
$('openHeats').addEventListener('click', () => { buildHeats(); openSheet('heatsSheet'); });
$('openLog').addEventListener('click', () => { buildLog(); openSheet('logSheet'); });

/* ---------- settings ---------- */
const s = {
  volume: $('volume'), voiceCountdown: $('voiceCountdown'), warnings: $('warnings'), countdownLen: $('countdownLen'),
  voiceSelect: $('voiceSelect'), rate: $('rate'), rateRow: $('rateRow'), themeSeg: $('themeSeg'),
  customList: $('customList'),
};

function buildVoiceSelect() {
  const opts = Object.entries(VOICE_SETS).map(([v, label]) => `<option value="${v}">${label}</option>`);
  for (const v of deviceVoices()) opts.push(`<option value="${esc(v.voiceURI)}">Phone: ${esc(v.name)} (${esc(v.lang)})</option>`);
  s.voiceSelect.innerHTML = opts.join('');
  s.voiceSelect.value = settings.voice;
  if (s.voiceSelect.value !== settings.voice) s.voiceSelect.value = 'liam';
}
onVoicesChanged(buildVoiceSelect);

function syncSettings() {
  s.volume.value = Math.round(settings.volume * 100);
  s.voiceCountdown.checked = settings.voiceCountdown;
  s.warnings.checked = settings.warnings;
  s.countdownLen.value = String(settings.countdown);
  buildVoiceSelect();
  s.rate.value = settings.rate;
  s.rateRow.hidden = !!VOICE_SETS[settings.voice];
  for (const b of s.themeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme));
  s.customList.innerHTML = settings.customRaces.length ? '' : '<li class="empty">None yet</li>';
  for (const r of settings.customRaces) {
    const li = document.createElement('li');
    li.innerHTML = `<span><b>${esc(r.name)}</b> · ${r.total}s race, ${r.lap}s lap · ${lapCount(r)} laps</span>`;
    const del = document.createElement('button');
    del.className = 'x'; del.type = 'button'; del.textContent = '✕'; del.setAttribute('aria-label', `Delete ${r.name}`);
    del.disabled = isRunning() || seq.active;
    del.addEventListener('click', () => { deleteCustomRace(r.id); syncSettings(); refreshAll(); });
    li.appendChild(del);
    s.customList.appendChild(li);
  }
  $('about').innerHTML = `SWRA Race Timer v${APP_VERSION}<br>Liam voice by <a href="https://elevenlabs.io" target="_blank" rel="noopener">ElevenLabs</a>`;
}

s.volume.addEventListener('input', () => { settings.volume = s.volume.value / 100; setVolume(settings.volume); save(); });
s.voiceCountdown.addEventListener('change', () => { settings.voiceCountdown = s.voiceCountdown.checked; save(); });
s.warnings.addEventListener('change', () => { settings.warnings = s.warnings.checked; save(); });
s.countdownLen.addEventListener('change', () => { settings.countdown = Number(s.countdownLen.value); save(); render(); });
s.voiceSelect.addEventListener('change', () => {
  settings.voice = s.voiceSelect.value; save();
  s.rateRow.hidden = !!VOICE_SETS[settings.voice];
  loadVoiceSet(settings.voice);
});
s.rate.addEventListener('input', () => { settings.rate = Number(s.rate.value); save(); });
$('previewVoice').addEventListener('click', async () => {
  unlockAudio();
  await loadVoiceSet(settings.voice);
  sayNow({ keys: ['lap3'], text: 'Lap 3' });
});
s.themeSeg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  settings.theme = b.dataset.theme; save(); applyTheme(); syncSettings();
});

$('addRaceForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('crName').value.trim();
  const total = Math.round(Number($('crTotal').value));
  const lap = Math.round(Number($('crLap').value));
  if (!name || !(total >= 10) || !(lap >= 2) || lap > total) {
    alert('Race length must be at least 10 s, and lap time between 2 s and the race length.');
    return;
  }
  addCustomRace(name, total, lap);
  e.target.reset();
  syncSettings(); buildRaceButtons();
});

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'sun' ? '#ffd400' : '#0b0d12';
}

/* ---------- heats ---------- */
function buildHeats() {
  const list = $('heatList');
  list.innerHTML = settings.heats.length ? '' : '<li class="empty">No heats yet. Add some below.</li>';
  const locked = seq.active;
  settings.heats.forEach((id, i) => {
    const li = document.createElement('li');
    if (seq.active && i === seq.index) li.classList.add('current');
    const options = allRaces().map(r => `<option value="${r.id}" ${r.id === id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    li.innerHTML = `<span class="heat-n">Heat ${i + 1}</span><select ${locked ? 'disabled' : ''}>${options}</select>
      <button type="button" class="x" data-act="up" aria-label="Move up" ${locked || i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="x" data-act="down" aria-label="Move down" ${locked || i === settings.heats.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="x" data-act="del" aria-label="Remove" ${locked ? 'disabled' : ''}>✕</button>`;
    li.querySelector('select').addEventListener('change', e => { settings.heats[i] = e.target.value; save(); });
    li.addEventListener('click', e => {
      const act = e.target.dataset?.act; if (!act) return;
      const h = settings.heats;
      if (act === 'up') [h[i - 1], h[i]] = [h[i], h[i - 1]];
      if (act === 'down') [h[i + 1], h[i]] = [h[i], h[i + 1]];
      if (act === 'del') h.splice(i, 1);
      save(); buildHeats();
    });
    list.appendChild(li);
  });
  $('heatGap').value = String(settings.heatGap);
  $('addHeat').disabled = locked;
  $('clearHeats').disabled = locked || !settings.heats.length;
  const t = $('seqToggle');
  t.textContent = seq.active ? 'End heat sequence' : 'Start heat sequence';
  t.classList.toggle('danger', seq.active);
  t.disabled = !seq.active && (!settings.heats.length || isRunning());
}
$('addHeat').addEventListener('click', () => {
  settings.heats.push(settings.heats.at(-1) || settings.raceId); save(); buildHeats();
});
$('clearHeats').addEventListener('click', () => {
  if (confirm('Remove all heats?')) { settings.heats = []; save(); buildHeats(); }
});
$('heatGap').addEventListener('change', e => { settings.heatGap = Number(e.target.value); save(); });
$('seqToggle').addEventListener('click', () => {
  if (seq.active) {
    if (isRunning() && !confirm('A heat is running. Stop it and end the sequence?')) return;
    if (isRunning()) stop();
    endSequence();
  } else {
    startSequence();
  }
  buildHeats(); refreshAll();
  $('heatsSheet').close();
});

/* ---------- log ---------- */
function logText(e) {
  const d = new Date(e.ts);
  const when = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const res = e.result === 'finished' ? `Finished ${e.laps}/${e.of} laps` : `Stopped at ${fmt(e.elapsed)} (lap ${e.laps}/${e.of})`;
  return { when, title: `${e.heat ? `Heat ${e.heat} · ` : ''}${e.race}`, res, pauses: e.pauses ? `${e.pauses} pause${e.pauses > 1 ? 's' : ''}` : '' };
}
function buildLog() {
  const log = getLog();
  const list = $('logList');
  list.innerHTML = log.length ? '' : '<li class="empty">No races yet.</li>';
  for (const e of log) {
    const t = logText(e);
    const li = document.createElement('li');
    li.className = e.result;
    li.innerHTML = `<span class="when">${esc(t.when)}</span><span><b>${esc(t.title)}</b><br>${esc(t.res)}${t.pauses ? ` · ${esc(t.pauses)}` : ''}</span>`;
    list.appendChild(li);
  }
  for (const id of ['shareLog', 'csvLog', 'clearLog']) $(id).disabled = !log.length;
}
function logCsv() {
  const rows = [['date', 'time', 'heat', 'race', 'race_s', 'lap_s', 'result', 'elapsed_s', 'laps', 'of', 'pauses']];
  for (const e of getLog()) {
    const d = new Date(e.ts);
    rows.push([d.toLocaleDateString('en-CA'), d.toTimeString().slice(0, 8), e.heat || '', e.race, e.total, e.lap, e.result, e.elapsed, e.laps, e.of, e.pauses]);
  }
  return rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
}
$('shareLog').addEventListener('click', async () => {
  const text = getLog().map(e => { const t = logText(e); return `${t.when} — ${t.title}: ${t.res}${t.pauses ? ` (${t.pauses})` : ''}`; }).join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'SWRA race log', text });
    else { await navigator.clipboard.writeText(text); alert('Race log copied to clipboard.'); }
  } catch {}
});
$('csvLog').addEventListener('click', () => {
  const blob = new Blob([logCsv()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `swra-race-log-${new Date().toLocaleDateString('en-CA')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('clearLog').addEventListener('click', () => {
  if (confirm('Delete the whole race log from this device?')) { clearLog(); buildLog(); }
});

/* ================================================================== *
 * Boot
 * ================================================================== */
function refreshAll() { buildRaceButtons(); setPhase(phase); }

applyTheme();
initAudio();

// Loading screen: show it briefly, until the voice clips are ready (tap to skip).
(() => {
  const splash = $('splash');
  if (!splash) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) splash.querySelector('svg')?.pauseAnimations?.();
  let gone = false;
  const hide = () => {
    if (gone) return; gone = true;
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 500);
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  Promise.race([Promise.all([wait(2200), voiceReady]), wait(5000)]).then(hide);
  splash.addEventListener('click', hide);
})();
syncLapToggle();
buildRaceButtons();
setPhase('idle');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the browser console.
window.__race = { get phase() { return phase; }, get events() { return events; }, get t0() { return t0; }, seq, settings,
  skip(sec) { t0 -= sec; t1 -= sec; gapEnd -= sec; for (const e of events) e.t -= sec; } };
