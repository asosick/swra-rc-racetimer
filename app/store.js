// Settings, race definitions and the race log, remembered on this device.

export const APP_VERSION = '0.4.1';

// From the SWRA 2-pole criteria doc.
export const BUILTIN_RACES = [
  { id: 'bronze10', name: 'Bronze 10', total: 150, lap: 15 },
  { id: 'bronze8',  name: 'Bronze 8',  total: 120, lap: 15 },
  { id: 'silver',   name: 'Silver',    total: 120, lap: 12 },
  { id: 'gold',     name: 'Gold',      total: 90,  lap: 9  },
];

const DEFAULTS = {
  raceId: 'bronze10',
  lapSounds: true,
  voiceCountdown: true,
  warnings: true,       // "One minute" / "Thirty seconds"
  countdown: 10,        // seconds
  volume: 0.9,          // 0..1
  voice: 'liam',        // recorded set ('liam' | 'classic') or a device voiceURI
  rate: 1.1,            // device voice speed
  theme: 'dark',        // 'dark' | 'sun'
  customRaces: [],      // [{ id, name, total, lap }]
  heats: [],            // [raceId, ...]
  heatGap: 120,         // seconds between heats; 0 = manual start
};

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export const settings = { ...DEFAULTS, ...read('settings', {}) };
// Carry over v0.1 settings.
if (read('settings', null) === null) {
  settings.raceId = read('raceKey', settings.raceId);
  settings.lapSounds = read('lapSounds', settings.lapSounds);
}

if (settings.voice === 'recorded') settings.voice = 'liam'; // v0.2.0 setting

export function save() { write('settings', settings); }

export function allRaces() { return [...BUILTIN_RACES, ...settings.customRaces]; }
export function getRace(id) { return allRaces().find(r => r.id === id) || BUILTIN_RACES[0]; }
export function lapCount(race) { return Math.ceil(race.total / race.lap - 1e-9); }

export function addCustomRace(name, total, lap) {
  const race = { id: 'c' + Date.now().toString(36), name, total, lap };
  settings.customRaces.push(race);
  save();
  return race;
}
export function deleteCustomRace(id) {
  settings.customRaces = settings.customRaces.filter(r => r.id !== id);
  if (settings.raceId === id) settings.raceId = BUILTIN_RACES[0].id;
  settings.heats = settings.heats.map(h => (h === id ? BUILTIN_RACES[0].id : h));
  save();
}

/* ---------- race log ---------- */
const LOG_MAX = 300;
export function getLog() { return read('raceLog', []); }
export function addLog(entry) {
  const log = getLog();
  log.unshift({ ts: Date.now(), ...entry });
  write('raceLog', log.slice(0, LOG_MAX));
}
export function clearLog() { write('raceLog', []); }
