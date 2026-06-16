#!/bin/sh
# 构建 release 二进制并打成可双击的 macOS .app bundle。
set -e
cd "$(dirname "$0")"

cargo build --release

APP="dist/Service Gateway Console.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/gateway-console "$APP/Contents/MacOS/gateway-console"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Service Gateway Console</string>
  <key>CFBundleDisplayName</key><string>Service Gateway 控制台</string>
  <key>CFBundleIdentifier</key><string>com.teamshell.gateway-console</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>gateway-console</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

echo "已生成：$APP"
echo "运行：open \"$APP\"    或   cargo run --release"
