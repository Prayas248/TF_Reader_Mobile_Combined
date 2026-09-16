// src/auth/defaultAuthClient.ts
// The one ApiAuthClient instance shared by every caller that needs to talk
// to flambeau's auth endpoints without building its own client —
// institutionSignIn.ts and tokenRefresh.ts both use this.
//
// Built lazily, on first real call, not at import time — so Jest never
// needs EXPO_PUBLIC_FLAMBEAU_BASE_URL set. Tests inject their own client via
// a `deps` parameter and never reach this function.
import { ApiAuthClient } from './ApiAuthClient';
import { resolveHostForAndroidEmulator } from '@/config/androidHost';

let cachedClient: ApiAuthClient | undefined;

export function getDefaultAuthClient(): ApiAuthClient {
  if (cachedClient !== undefined) return cachedClient;

  const configuredBaseUrl = process.env.EXPO_PUBLIC_FLAMBEAU_BASE_URL;
  if (configuredBaseUrl === undefined || configuredBaseUrl.trim() === '') {
    throw new Error('EXPO_PUBLIC_FLAMBEAU_BASE_URL must be set.');
  }

  const baseUrl = resolveHostForAndroidEmulator(configuredBaseUrl.trim());
  cachedClient = new ApiAuthClient({ baseUrl });
  return cachedClient;
}
