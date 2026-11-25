#!/usr/bin/env bash
# Builds runner/widget-host into the APK $1 with the SDK's own tools (javac, d8, aapt2, zipalign, apksigner) and a
# throwaway key: no Gradle, a few seconds. Needs ANDROID_HOME (or ANDROID_SDK_ROOT) and a JDK 11+ on PATH.
set -euo pipefail
OUT_APK="$1"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?no Android SDK}}"
SRC="$(cd "$(dirname "$0")/widget-host" && pwd)"
BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)"
JAR="$(ls -d "$SDK"/platforms/android-*/ | sort -V | tail -1)android.jar"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/classes" "$W/dex"
javac --release 11 -nowarn -classpath "$JAR" -d "$W/classes" "$SRC"/src/qa/widgethost/*.java
"$BT"d8 --lib "$JAR" --min-api 26 --output "$W/dex" $(find "$W/classes" -name '*.class')
"$BT"aapt2 link -I "$JAR" --manifest "$SRC/AndroidManifest.xml" -o "$W/base.apk"
( cd "$W/dex" && zip -q "$W/base.apk" classes.dex )
"$BT"zipalign -f 4 "$W/base.apk" "$W/aligned.apk"
keytool -genkeypair -keystore "$W/k.jks" -storepass qahost -keypass qahost -alias qa -keyalg RSA -keysize 2048 \
  -validity 2 -dname "CN=app-qa widget host" > /dev/null 2>&1
"$BT"apksigner sign --ks "$W/k.jks" --ks-pass pass:qahost --key-pass pass:qahost --out "$OUT_APK" "$W/aligned.apk"
