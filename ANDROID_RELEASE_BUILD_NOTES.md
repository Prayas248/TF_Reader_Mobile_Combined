# Android release build — two traps, both found the hard way

## 1. `process.env.X` must be static — never `process.env[VAR]`

Expo's babel plugin inlines `EXPO_PUBLIC_*` values into the bundle by statically replacing
`process.env.EXPO_PUBLIC_FOO` with a literal. It cannot see through a computed access like
`process.env[someVariable]` — that expression is left as-is, and in a compiled release bundle
there is no real `process.env` object at runtime to resolve it against, so it silently evaluates
to `undefined`.

This is exactly what broke catalogue search on every release APK: `src/config/search.ts` read
`process.env[ENV_VAR]` (`ENV_VAR = 'EXPO_PUBLIC_SEARCH_PIPELINE'`), which came back `undefined` in
release, so `resolveSearchPipelineKind` fell back to `'fixture'` — the release app silently
searched a local canned dataset instead of the real backend, on every release build, regardless of
`.env`. Dev/Metro builds were unaffected (dev mode's `process.env` is closer to a real object), so
it only ever showed up in a release APK. `src/config/catalogue.ts` already did this correctly
(`process.env.EXPO_PUBLIC_CATALOGUE_SOURCE`, static) — match that pattern for any new
`EXPO_PUBLIC_*` read, and grep for `process.env\[` before adding one.

## 2. A locally-built release APK can still show the Expo dev-client launcher

This project's checked-in `android/` folder has `expo-dev-client` wired in for every build variant
(it's a normal dependency, and `expo prebuild` doesn't strip it per-variant). Running
`cd android && ./gradlew assembleRelease` produces a real release APK with the JS bundle correctly
embedded — but whether opening it goes straight into the app or lands on the dev-client's
"Development Build" home screen (Development Servers / Scan QR Code) depends on **leftover
dev-client state from a previous install**, not on the APK itself.

Symptom: the app opens straight into real screens for a while (including across `adb install -r`
reinstalls of a newly-rebuilt APK), then — with no rebuild, no code change — a plain
`am force-stop` + relaunch of the *exact same* installed APK suddenly lands on the dev-client home
screen instead. `adb install -r` preserves app data, so whatever dev-client had cached from earlier
testing carries forward inconsistently across rebuilds; a `force-stop` is enough to expose it.

Fix: don't `install -r` over a stale test install when verifying a release build behaves like a
real cold install would. Uninstall first, then install fresh:

```
adb uninstall com.taylorandfrancis.tfreader.dev
adb install android/app/build/outputs/apk/release/app-release.apk
```

No rebuild needed — this is purely about install state, not the APK's contents. If it still lands
on the dev-client screen after a true uninstall+reinstall, that's a real build-config problem worth
investigating (e.g. whether `expo-dev-client` should be excluded from the release variant
entirely); as of this writing a clean install has been sufficient every time.
