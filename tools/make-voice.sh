#!/usr/bin/env bash
# Generates the recorded voice clips in app/voice/ (macOS: needs `say` and `ffmpeg`).
#
# To use a real person's voice instead, record the same phrases and drop them in
# app/voice/ with the same file names (mono .m4a, silence trimmed). See CLIPS below.
#
# Usage: tools/make-voice.sh [VoiceName]     (default: Samantha)
set -euo pipefail

VOICE="${1:-Samantha}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/app/voice"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/voice.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# key|phrase   (keys must match clipKeys() in app/audio.js and app/sw.js)
CLIPS=()
for i in $(seq 1 20); do CLIPS+=("n$i|$i"); done
for i in $(seq 1 30); do CLIPS+=("lap$i|Lap $i"); done
for i in $(seq 1 20); do CLIPS+=("heat$i|Heat $i"); done
CLIPS+=("go|Go!" "final|Final lap" "min1|One minute" "sec30|Thirty seconds" "paused|Race paused")

for entry in "${CLIPS[@]}"; do
  key="${entry%%|*}"; phrase="${entry#*|}"
  say -v "$VOICE" -r 195 -o "$TMP/$key.aiff" "$phrase"
  # Trim leading/trailing silence, normalise loudness, mono AAC.
  ffmpeg -loglevel error -y -i "$TMP/$key.aiff" \
    -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-14:TP=-1:LRA=7" \
    -ar 44100 -ac 1 -c:a aac -b:a 48k "$OUT/$key.m4a"
  printf '.'
done
echo
echo "Wrote ${#CLIPS[@]} clips to $OUT"
