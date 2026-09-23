// src/store/secureStorage.ts
// Secure storage for the refresh token — the only credential that survives app restarts.
//
// WHY NOT AsyncStorage: the refresh token is a long-lived credential. AsyncStorage
// is unencrypted on both platforms; expo-secure-store backs Keychain (iOS) and
// Keystore-backed encrypted storage (Android). The flambeau auth design (§5) is
// explicit about this split: access token in memory, refresh token in secure storage.
//
// ONE KEY, ONE TOKEN. This file does not store the access token (that is the
// sessionStore's job) or anything else. If a second secure value is needed, add a
// named constant here rather than spreading key strings across the codebase.
import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'session.refreshToken';

/** Persists the refresh token to Keychain / Keystore. */
export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/** Reads the refresh token. Returns null if none is stored. */
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/** Removes the refresh token — called on sign-out and on refresh failure. */
export async function deleteRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

// A SECOND KEY, DELIBERATELY NOT CLEARED BY SIGN-OUT. This is the opaque device id
// `POST /api/v1/auth/token`/`/refresh` hand back for an institutional (SAML) sign-in —
// echoing it on the NEXT `saml/start` is what lets a returning device reclaim the same
// concurrent seat instead of spending a new one (see SamlUserMapper.java, backend). It
// represents this physical device/install, not this session, so it must survive sign-out
// exactly like a real device would if the reader signed in again five minutes later. Only
// ever deleted if that device explicitly wants to "forget" itself; there is no such action
// today, so this has no delete function yet — add one if/when that's built.
const DEVICE_ID_KEY = 'auth.deviceId';

/** Persists the institutional device id, for the next `saml/start` call to echo back. */
export async function saveDeviceId(deviceId: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
}

/** Reads this device's institutional device id. Returns null the first time this device signs in. */
export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_ID_KEY);
}
