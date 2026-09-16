// src/config/androidHost.ts
import { Platform } from 'react-native';

// The Android emulator's own loopback ("localhost"/"127.0.0.1") is the emulator itself, not the
// host machine running the backend — 10.0.2.2 is the documented emulator -> host alias. This must
// be applied even to an EXPLICIT env override, not only a computed default: sync/config.ts and
// download/config.ts already resolve this correctly for their own defaults, but a base URL copied
// verbatim into .env from an iOS-only setup (or read with no host-resolution at all, like
// catalogue.ts and the flambeau clients) carries the same trap.
export function resolveHostForAndroidEmulator(url: string): string {
  if (Platform.OS !== 'android') return url;
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, '$110.0.2.2');
}
