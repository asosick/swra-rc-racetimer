#!/usr/bin/env bash
# Generates the recorded voice clips in app/voice/.
#
#   tools/make-voice.sh elevenlabs            ElevenLabs TTS (needs ELEVENLABS_API_KEY)
#   tools/make-voice.sh elevenlabs --voices   list the voices on your ElevenLabs account
#   tools/make-voice.sh say [VoiceName]       macOS `say` (default voice: Samantha)
#
# ElevenLabs options (environment variables):
#   ELEVENLABS_API_KEY   optional; if unset, the key is read from the macOS Keychain.
#                        Store it once (prompts for the key, nothing is echoed):
#                          security add-generic-password -U -s swra-elevenlabs -a "$USER" -w
#                        It can also go in tools/.env (gitignored) or be exported.
#   ELEVENLABS_VOICE_ID  voice to use (default: Liam, TX3LPaxmHKxFdv7VOQHJ)
#   ELEVENLABS_MODEL     model id (default: eleven_v4)
#   ONLY="lap1 go"       regenerate just these clips
#   OUT=dir              write somewhere other than app/voice
#
# Output: app/voice/liam/ (ElevenLabs) or app/voice/classic/ (say). The app lets
# you pick either set in Settings. To use a real person's voice, record the
# phrases below into a set folder with the same file names (mono .m4a).
#
# Needs: ffmpeg, curl (and jq for --voices).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/tools/.env" ]] && set -a && source "$ROOT/tools/.env" && set +a

PROVIDER="${1:-}"
OUT_SET=""
TMP="$(mktemp -d "${TMPDIR:-/tmp}/voice.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Phrases. key|text  (keys must match clipKeys() in app/audio.js and app/sw.js)
# Numbers are spelled out: TTS engines say them more naturally that way.
# [excited]/[shouting] are delivery tags for ElevenLabs v3+ models; they are
# stripped for other engines.
# ---------------------------------------------------------------------------
WORDS=(zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
  fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three
  twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty)
cap() { printf '%s' "$(tr '[:lower:]' '[:upper:]' <<< "${1:0:1}")${1:1}"; }

CLIPS=()
for i in $(seq 1 20); do
  if (( i <= 3 )); then CLIPS+=("n$i|[shouting] $(cap "${WORDS[$i]}")!"); else CLIPS+=("n$i|[excited] $(cap "${WORDS[$i]}")!"); fi
done
for i in $(seq 1 30); do CLIPS+=("lap$i|[excited] Lap ${WORDS[$i]}!"); done
for i in $(seq 1 20); do CLIPS+=("heat$i|[excited] Heat ${WORDS[$i]}!"); done
CLIPS+=("go|[shouting] GO!" "final|[shouting] FINAL LAP!" "min1|[excited] One minute!" "sec30|[excited] Thirty seconds!" "paused|Race paused.")

strip_tags() { sed -E 's/\[[a-z ]+\] ?//g' <<< "$1"; }

# ---------------------------------------------------------------------------
# Providers: synth <text> <outfile-without-extension>  -> writes an audio file, echoes its path
# ---------------------------------------------------------------------------
EL_API="https://api.elevenlabs.io/v1"

synth_elevenlabs() {
  local text="$1" out="$2.mp3" body code
  [[ "$EL_MODEL" =~ ^eleven_v[3-9] ]] || text="$(strip_tags "$text")"
  body=$(printf '{"text":%s,"model_id":"%s","seed":7,"voice_settings":{"stability":0.0,"similarity_boost":0.8}}' \
    "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$EL_MODEL")
  code=$(curl -sS -o "$out" -w '%{http_code}' -X POST \
    "$EL_API/text-to-speech/$EL_VOICE?output_format=mp3_44100_128" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H 'Content-Type: application/json' -d "$body")
  if [[ "$code" != 200 ]]; then
    echo >&2; echo "ElevenLabs returned HTTP $code for \"$text\":" >&2; cat "$out" >&2; echo >&2
    exit 1
  fi
  echo "$out"
}

synth_say() {
  local text; text="$(strip_tags "$1")"; local out="$2.aiff"
  say -v "$SAY_VOICE" -r 195 -o "$out" "$text"
  echo "$out"
}

case "$PROVIDER" in
  elevenlabs)
    if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
      ELEVENLABS_API_KEY="$(security find-generic-password -s swra-elevenlabs -w 2>/dev/null || true)"
    fi
    if [[ -z "$ELEVENLABS_API_KEY" ]]; then
      echo "No ElevenLabs key found. Store it in the Keychain with:" >&2
      echo '  security add-generic-password -U -s swra-elevenlabs -a "$USER" -w' >&2
      exit 1
    fi
    if [[ "${2:-}" == "--voices" ]]; then
      curl -sS "$EL_API/voices" -H "xi-api-key: $ELEVENLABS_API_KEY" \
        | jq -r '.voices[] | "\(.voice_id)  \(.name)  [\(.labels.gender // "-"), \(.labels.accent // "-"), \(.labels.description // .labels.descriptive // "-")]"'
      exit 0
    fi
    EL_VOICE="${ELEVENLABS_VOICE_ID:-TX3LPaxmHKxFdv7VOQHJ}"
    EL_MODEL="${ELEVENLABS_MODEL:-eleven_v4}"
    SYNTH=synth_elevenlabs
    OUT_SET=liam
    echo "ElevenLabs voice $EL_VOICE, model $EL_MODEL"
    ;;
  say)
    SAY_VOICE="${2:-Samantha}"
    SYNTH=synth_say
    OUT_SET=classic
    ;;
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac

OUT="${OUT:-$ROOT/app/voice/$OUT_SET}"
mkdir -p "$OUT"

# Countdown numbers are one second apart, so squeeze any that run long
# (pitch is kept; only the pace changes).
MAX_COUNT=0.8
fit_clip() {
  local f="$1" d tempo
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  if awk -v d="$d" -v m="$MAX_COUNT" 'BEGIN{exit !(d>m)}'; then
    tempo=$(awk -v d="$d" -v m="$MAX_COUNT" 'BEGIN{printf "%.3f", d/(m-0.03)}')
    ffmpeg -loglevel error -y -i "$f" -af "atempo=$tempo" -ar 44100 -ac 1 -c:a aac -b:a 48k "$f.tmp.m4a"
    mv "$f.tmp.m4a" "$f"
  fi
}
[[ "${1:-}" == "--fit-only" ]] && exit 0

n=0
for entry in "${CLIPS[@]}"; do
  key="${entry%%|*}"; text="${entry#*|}"
  if [[ -n "${ONLY:-}" && " $ONLY " != *" $key "* ]]; then continue; fi
  src="$($SYNTH "$text" "$TMP/$key")"
  # Trim leading/trailing silence, normalise loudness, mono AAC.
  ffmpeg -loglevel error -y -i "$src" \
    -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-14:TP=-1:LRA=7" \
    -ar 44100 -ac 1 -c:a aac -b:a 48k "$OUT/$key.m4a"
  [[ "$key" =~ ^(n[0-9]+|go)$ ]] && fit_clip "$OUT/$key.m4a"
  n=$((n + 1))
  printf '.'
done
echo
echo "Wrote $n clips to $OUT"
