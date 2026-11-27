# Android WebView shell

This directory contains the minimal Android wrapper for the offline QSL Log web app.

The wrapper:

- loads `assets/index.html` from inside the APK — no local server is needed;
- enables JavaScript and DOM storage, so records persist in the app;
- uses the system file picker for importing `.json` / `.zip` backups;
- exposes a tiny `QSLAndroid.saveFile()` bridge so JSON/CSV/ZIP exports are written to
  `Download/QSL LOGBOOK/` through `MediaStore` (no storage permission);
- handles the system back button by closing any open dialog first.

## Requirements

Tested with Ubuntu/Debian arm64 packages:

```bash
sudo apt-get install -y openjdk-17-jdk-headless aapt android-sdk-build-tools \
  dalvik-exchange zipalign apksigner python3
```

You also need the Android API 29 `android.jar`. Download the official platform package
(for example `platform-29_r05.zip` from `dl.google.com/android/repository/`) and point
`ANDROID_JAR` at its `android.jar`.

## Build

```bash
cd android
ANDROID_JAR=/path/to/android-29/android.jar ./build.sh
```

The signed APK is written to `android/build/QSL-Log-1.3.0.apk`.

The first build creates `android/build/qsl-logbook.keystore`. Keep that file if you want
to publish updates that install over the previous APK. It is intentionally excluded from
Git. You can override the keystore and password:

```bash
KEYSTORE=/secure/path/qsl.keystore KS_PASS='change-me' ./build.sh
```

## Notes

- The Android wrapper is not a Trusted Web Activity; it is a plain `WebView` loading
  bundled assets. This keeps it fully offline and independent of browser install rules.
- Service worker registration is skipped on `file://` automatically; the APK does not need
  a service worker because its assets are already local.
- The package name is `com.dsh.qsllog`; changing it creates a different app identity.
