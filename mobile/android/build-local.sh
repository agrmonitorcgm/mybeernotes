#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ -z "$SDK_ROOT" ]]; then
  echo "Set ANDROID_SDK_ROOT or ANDROID_HOME to your Android SDK directory." >&2
  exit 1
fi

BUILD_TOOLS="$SDK_ROOT/build-tools/35.0.0"
ANDROID_JAR="$SDK_ROOT/platforms/android-35/android.jar"
BUILD_DIR="$PROJECT_DIR/build/manual-$(date +%Y%m%d-%H%M%S)"
OUTPUT_DIR="$PROJECT_DIR/build/outputs/apk/debug"

mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex" "$OUTPUT_DIR"
"$BUILD_TOOLS/aapt2" compile --dir "$PROJECT_DIR/app/src/main/res" -o "$BUILD_DIR/resources.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD_DIR/app-unsigned-unaligned.apk" -I "$ANDROID_JAR" \
  --manifest "$PROJECT_DIR/app/src/main/AndroidManifest.xml" --java "$BUILD_DIR/gen" \
  --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 0.1.0 \
  -A "$PROJECT_DIR/app/src/main/assets" "$BUILD_DIR/resources.zip"

mapfile -t GENERATED_JAVA < <(find "$BUILD_DIR/gen" -name '*.java')
java -m jdk.compiler/com.sun.tools.javac.Main \
  -source 17 -target 17 -encoding UTF-8 -classpath "$ANDROID_JAR" \
  -d "$BUILD_DIR/classes" \
  "$PROJECT_DIR/app/src/main/java/com/george/beerdiary/MainActivity.java" \
  "${GENERATED_JAVA[@]}"

mapfile -t CLASS_FILES < <(find "$BUILD_DIR/classes" -name '*.class')
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --min-api 26 --output "$BUILD_DIR/dex" "${CLASS_FILES[@]}"
cp "$BUILD_DIR/app-unsigned-unaligned.apk" "$BUILD_DIR/app-with-dex-unaligned.apk"
(cd "$BUILD_DIR/dex" && zip -q -j "$BUILD_DIR/app-with-dex-unaligned.apk" classes.dex)
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD_DIR/app-with-dex-unaligned.apk" "$BUILD_DIR/beer-diary-unsigned.apk"

KEYSTORE="$PROJECT_DIR/debug.keystore"
if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android \
    -alias androiddebugkey -keypass android -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000
fi

APK="$OUTPUT_DIR/beer-diary-debug.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android \
  --key-pass pass:android --out "$APK" "$BUILD_DIR/beer-diary-unsigned.apk"
"$BUILD_TOOLS/apksigner" verify --verbose "$APK"
echo "Built: $APK"
