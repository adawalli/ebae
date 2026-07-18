#!/usr/bin/env bash
# Regenerates every app icon from one source: the letter "e" in IBM Plex Mono
# SemiBold on the --primary blue, matching the sidebar mark in
# src/components/app-sidebar.tsx.
#
# Needs ImageMagick 7 (`brew install imagemagick`). Fetches the font if absent.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=public
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ebae-icons.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# sRGB of --primary oklch(0.52 0.2 232) from globals.css. Out of sRGB gamut, so
# this is the clipped value browsers land on anyway.
BLUE="#0075c6"

FONT=${PLEX_MONO:-$WORK/IBMPlexMono-SemiBold.ttf}
if [ ! -f "$FONT" ]; then
  gh release download '@ibm/plex-mono@2.5.0' -R IBM/plex -p ibm-plex-mono.zip -D "$WORK"
  unzip -q "$WORK/ibm-plex-mono.zip" -d "$WORK"
  cp "$WORK/ibm-plex-mono/fonts/complete/ttf/IBMPlexMono-SemiBold.ttf" "$FONT"
fi

# The glyph, trimmed to its ink. Rendering then trimming beats -gravity center,
# which centres the em box and leaves a lowercase letter sitting visibly low.
magick -size 1024x1024 xc:none -font "$FONT" -pointsize 900 \
  -fill white -gravity center -annotate +0+0 'e' -trim +repage "$WORK/e.png"

# tile <size> <radius%> <glyph-height%> <background> <out>
tile() {
  local size=$1 radius=$2 glyph=$3 bg=$4 out=$5
  local r=$((size * radius / 100))
  local h=$((size * glyph / 100))
  # An opaque tile drops its alpha channel: iOS and maskable surfaces composite
  # transparency against black, which would ring the icon in dark edges.
  local flatten=(); [ "$bg" = none ] || flatten=(-alpha remove -alpha off)
  magick -size "${size}x${size}" xc:"$bg" -fill "$BLUE" \
    -draw "roundrectangle 0,0 $((size - 1)),$((size - 1)) $r,$r" \
    \( "$WORK/e.png" -resize "x${h}" \) -gravity center -composite \
    ${flatten[@]+"${flatten[@]}"} -strip "$out"
}

# purpose "any" + favicon: rounded tile, transparent corners.
tile 512 22 52 none "$OUT/icon-512.png"
tile 192 22 52 none "$OUT/icon-192.png"
tile 32 22 52 none src/app/icon.png

# iOS composites onto an opaque square and applies its own squircle mask, so
# ship full bleed with no rounding of our own.
tile 180 0 52 "$BLUE" "$OUT/apple-touch-icon.png"

# purpose "maskable": platforms crop to a circle, so the glyph has to stay
# inside the 80% safe zone. Full bleed, no rounding, no transparency.
tile 512 0 40 "$BLUE" "$OUT/icon-maskable-512.png"

printf 'wrote:\n'
identify -format '  %f  %wx%h  %[channels]\n' \
  "$OUT/icon-512.png" "$OUT/icon-192.png" src/app/icon.png \
  "$OUT/apple-touch-icon.png" "$OUT/icon-maskable-512.png"
