#!/bin/sh
set -eu

overlay_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
overlay_app="$overlay_root/build/Focus Desktop Overlay.app"
overlay_arch=$(/usr/bin/uname -m)
overlay_workspace=$(CDPATH= cd -- "$overlay_root/../.." && pwd)

/bin/mkdir -p "$overlay_app/Contents/MacOS" "$overlay_root/.swift-module-cache"
/usr/bin/swiftc -swift-version 5 -O \
  -target "$overlay_arch-apple-macosx12.0" \
  -module-cache-path "$overlay_root/.swift-module-cache" \
  -framework AppKit -framework WebKit \
  "$overlay_root/main.swift" \
  -o "$overlay_app/Contents/MacOS/FocusDesktopOverlay"
/bin/cp "$overlay_root/Info.plist" "$overlay_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :FOCUSOverlayBridgeFile $overlay_workspace/.focus-overlay-bridge.json" "$overlay_app/Contents/Info.plist"
/usr/bin/codesign --force --sign - --timestamp=none "$overlay_app"
/usr/bin/plutil -lint "$overlay_app/Contents/Info.plist"
printf '%s\n' "$overlay_app"
