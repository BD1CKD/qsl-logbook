#!/usr/bin/env bash
set -euo pipefail

# QSL Log — Android WebView wrapper build
# Requires: JDK 17+, aapt/dx/zipalign/apksigner, and Android API 29 android.jar.
# See android/README.md for setup details.

ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB_ROOT="$(cd "$ROOT/.." && pwd)"
VERSION_NAME="1.3.0"
APK_NAME="QSL-Log-${VERSION_NAME}.apk"
ANDROID_JAR="${ANDROID_JAR:-/opt/android-sdk/platforms/android-29/android.jar}"
KEYSTORE="${KEYSTORE:-$ROOT/build/qsl-logbook.keystore}"
KS_PASS="${KS_PASS:-qsllog2026}"

find_tool() {
  local name="$1"
  local fallback="$2"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
  elif [ -x "$fallback" ]; then
    echo "$fallback"
  else
    echo "Missing tool: $name" >&2
    exit 1
  fi
}

AAPT="$(find_tool aapt /usr/lib/android-sdk/build-tools/debian/aapt)"
DX="$(find_tool dx /usr/lib/android-sdk/build-tools/debian/dx)"
ZIPALIGN="$(find_tool zipalign /usr/bin/zipalign)"
APKSIGNER="$(find_tool apksigner /usr/bin/apksigner)"

if [ ! -f "$ANDROID_JAR" ]; then
  echo "Android API 29 jar not found: $ANDROID_JAR" >&2
  echo "Set ANDROID_JAR=/path/to/android.jar or see android/README.md" >&2
  exit 1
fi

cd "$ROOT"
rm -rf build gen classes assets
mkdir -p build gen classes assets

echo "[1/7] copy web assets"
for item in index.html styles.css app.js zip.js sw.js manifest.webmanifest icons; do
  cp -a "$WEB_ROOT/$item" assets/
done

echo "[2/7] aapt resources + assets"
"$AAPT" package -f -m -J gen -M AndroidManifest.xml -S res -A assets \
  -I "$ANDROID_JAR" -F build/unsigned.apk

echo "[3/7] javac"
javac -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_JAR" \
  -d classes src/com/dsh/qsllog/MainActivity.java gen/com/dsh/qsllog/R.java

echo "[4/7] dx -> classes.dex"
"$DX" --dex --min-sdk-version=29 --output=build/classes.dex classes

echo "[5/7] add classes.dex"
python3 - "$ROOT/build/unsigned.apk" "$ROOT/build/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "[6/7] zipalign + sign"
"$ZIPALIGN" -f 4 build/unsigned.apk build/aligned.apk
mkdir -p "$(dirname "$KEYSTORE")"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias qsllog -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=QSL Log,O=Local,C=CN"
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "build/$APK_NAME" build/aligned.apk

echo "[7/7] verify"
"$APKSIGNER" verify --verbose --print-certs "build/$APK_NAME" | head -12
"$AAPT" dump badging "build/$APK_NAME" | head -12
echo "APK ready: $ROOT/build/$APK_NAME"
