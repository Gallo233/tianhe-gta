#!/bin/bash
# Build the Tianhe demo and pack it for teammates: guangzhou/release/天河demo试玩_YYYYMMDD.zip
#   bash guangzhou/demo/release_kit/make_release.sh
# The zip holds tianhe-demo/{game/, start-windows.bat, start-mac.command, tools/, README.txt}. Every name inside is
# ASCII (Chinese names in a zip made on a Mac come out garbled in some Windows unzip tools); README.txt is UTF-8 with
# a BOM and CRLF so Notepad shows it right.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
DEMO="$(dirname "$KIT")"
OUT="$(dirname "$DEMO")/release"
STAMP="$(date +%Y%m%d)"
cd "$DEMO"
npm run build
rm -rf "$OUT/tianhe-demo"
mkdir -p "$OUT/tianhe-demo"
# the game, minus assets nothing loads any more (the Costa Brava cast and cars)
rsync -a --delete \
  --exclude 'assets/characters/CH_Mateo*' --exclude 'assets/characters/CH_LinXi*' --exclude 'assets/characters/CH_Otis*' \
  --exclude 'assets/vehicles/vehicle_*' --exclude 'voice/audition' --exclude '.DS_Store' \
  $([ "${INCLUDE_MUSIC:-0}" = 1 ] || echo "--exclude assets/music/*.mp3 --exclude assets/music/*.jpg --exclude assets/music/tracks.json") \
  dist/ "$OUT/tianhe-demo/game/"
cp "$KIT/start-windows.bat" "$KIT/start-mac.command" "$KIT/README.txt" "$OUT/tianhe-demo/"
mkdir -p "$OUT/tianhe-demo/tools"
cp "$KIT/tools/server.pl" "$KIT/tools/server.ps1" "$OUT/tianhe-demo/tools/"
chmod +x "$OUT/tianhe-demo/start-mac.command" "$OUT/tianhe-demo/tools/server.pl"
ZIP="$OUT/天河demo试玩_${STAMP}.zip"
rm -f "$ZIP"
(cd "$OUT" && zip -qr -X "$ZIP" tianhe-demo)
du -sh "$OUT/tianhe-demo" "$ZIP"
