#!/bin/bash
# Frozen code snapshot of external/holtburger for benching while the live tree changes.
# Code dirs are real copies; heavy data is symlinked. Usage: mksnap.sh NAME
set -e
SRC=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
SNAP=/mnt/wbterminal2/hb-snap/$1
rm -rf "$SNAP"; mkdir -p "$SNAP/apps/holtburger-web/scene3d"
for e in "$SRC"/*; do b=$(basename "$e"); case "$b" in apps) ;; scripts) cp -a "$e" "$SNAP/scripts" ;; *) ln -s "$e" "$SNAP/$b" ;; esac; done
for e in "$SRC"/apps/*; do b=$(basename "$e"); [ "$b" = holtburger-web ] || ln -s "$e" "$SNAP/apps/$b"; done
W="$SRC/apps/holtburger-web"
for e in "$W"/* "$W"/.[!.]*; do [ -e "$e" ] || continue; b=$(basename "$e")
  case "$b" in
    scene3d) for f in "$e"/*; do fb=$(basename "$f"); if [ "$fb" = assets ]; then ln -s "$f" "$SNAP/apps/holtburger-web/scene3d/assets"; else cp -a "$f" "$SNAP/apps/holtburger-web/scene3d/"; fi; done ;;
    app|ui|plugins|*.html|*.js|*.json|*.mjs) cp -a "$e" "$SNAP/apps/holtburger-web/" ;;
    *) ln -s "$e" "$SNAP/apps/holtburger-web/$b" ;;
  esac
done
du -sh --apparent-size "$SNAP" | tail -1
