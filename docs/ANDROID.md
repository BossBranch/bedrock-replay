# Android APK (hub on phone)

Minecraft on the **same phone** joins `127.0.0.1:19132` (LIVE).  
Same Node hub as PC; RakNet = **jsp-raknet** (no native `.node`).

## What you need

1. [Android Studio](https://developer.android.com/studio) (SDK 35 + NDK / CMake via SDK Manager)
2. Node.js 18+ on the PC (to prepare the embedded project)
3. Phone/emulator with Android 8+ (API 26+)

## Prepare (once / after hub code changes)

From repo root:

```bat
node tools/download-libnode.mjs
node tools/prepare-android-node.mjs
```

- `download-libnode` → `android/app/libnode/` (`libnode.so` + headers)
- `prepare-android-node` → `android/app/src/main/assets/nodejs-project/`

## Build APK

**Important on Windows:** if the project lives under a path with Cyrillic (e.g. `C:\Users\Влад\…`), the NDK linker breaks. Build from an ASCII copy:

```bat
npm run android:bundle
robocopy android C:\dev\bedrock-replay\android /E /XD .cxx build .gradle
```

Put SDK/NDK on an ASCII path too (example: `C:\Android\Sdk`), then:

```bat
cd /d C:\dev\bedrock-replay\android
set ANDROID_HOME=C:\Android\Sdk
gradlew.bat assembleDebug
```

APK:

`C:\dev\bedrock-replay\android\app\build\outputs\apk\debug\app-debug.apk`

Or open `C:\dev\bedrock-replay\android` in Android Studio → Run.

## Use

1. Install APK, open app (notification = hub running)
2. Set destination host/port + client version
3. In Minecraft → Servers → `127.0.0.1` port `19132`
4. `.start` / `.play` as on PC

## Emulator (Android Studio)

Open the **ASCII** project so NDK works:

`C:\dev\bedrock-replay\android`

1. **Device Manager** → Create Device → download a system image if needed → Start
2. **Run** (▶) the app, or  
   `adb install -r app\build\outputs\apk\debug\app-debug.apk`
3. Logs: **Logcat** filter `BedrockHub` / `AndroidRuntime`

If the app showed “page load error” then crashed: rebuild after `libc++_shared.so` is in `app/libnode/bin/<abi>/` (done by `npm run android:libnode` when NDK is present).

## Layout

| Path | Role |
|------|------|
| `src/mobileMain.js` | Node entry + local UI API `:18766` |
| `src/mobile/www/` | WebView UI |
| `android/` | Kotlin + JNI + nodejs-mobile |
| `tools/prepare-android-node.mjs` | Bundle hub into assets |

## Limits (v1)

- Offline mode first (`offline: true`); Microsoft login on phone is harder
- Pure-JS RakNet can be slower than native on PC
- One client (`forceSingle`) — only the phone’s Minecraft
