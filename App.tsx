// App.tsx — Expo entry component.
//
// NavigationContainer + SafeAreaProvider are the two required wrappers — RootNavigator (the
// tab-based Catalogue/Search/Library/Profile shell) owns no NavigationContainer of its own.
//
// Fonts load here, once, before anything renders. Nothing downstream ever
// touches expo-font directly — by the time RootNavigator mounts, every
// fontFamily name in tokens.ts is guaranteed to be registered.
//
// `useAutoSync()` and `useAudioPlayerSetup()` are app-wide and unrelated to routing, so they mount
// here rather than inside RootNavigator — see the reader engine's own integration reference for why
// useAutoSync must be mounted once at the true app root.
import { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { OpenSans_300Light, OpenSans_400Regular, OpenSans_700Bold } from '@expo-google-fonts/open-sans';
import { Aleo_300Light, Aleo_400Regular, Aleo_700Bold } from '@expo-google-fonts/aleo';
import { NotoSans_300Light, NotoSans_400Regular, NotoSans_700Bold } from '@expo-google-fonts/noto-sans';
import { Cinzel_600SemiBold } from '@expo-google-fonts/cinzel';
import RootNavigator from './src/navigation/RootNavigator';
import { bootstrapAuth } from './src/auth/tokenRefresh';
import { useAudioPlayerSetup } from '@/features/reader/audio/useAudioPlayerSetup';
import { useAutoSync } from '@/features/sync/useAutoSync';
import BootSplash from '@/boot/BootSplash';
import { useInstitutionStore } from '@store/institutionStore';
import { useSessionStore } from '@store/sessionStore';

SplashScreen.preventAutoHideAsync();

export default function App() {
  const [fontsLoaded] = useFonts({
    OpenSans_300Light,
    OpenSans_400Regular,
    OpenSans_700Bold,
    Aleo_300Light,
    Aleo_400Regular,
    Aleo_700Bold,
    NotoSans_300Light,
    NotoSans_400Regular,
    NotoSans_700Bold,
    Cinzel_600SemiBold,
  });

  // Same two readiness signals RootNavigator itself gates on — read here too
  // so BootSplash can cover the whole boot window rather than just the font
  // load, and NavigationContainer can mount (and start Catalogue's own data
  // fetch) underneath it instead of only after it hides.
  const hasHydrated = useInstitutionStore((s) => s._hasHydrated);
  const authReady = useSessionStore((s) => s._authReady);
  const isReady = fontsLoaded && hasHydrated && authReady;

  // Kept true until BootSplash's own exit fade finishes, so the fade always
  // plays out rather than being yanked the instant `isReady` flips.
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  // Fire-and-forget: bootstrapAuth flips sessionStore._authReady itself, on
  // both success and failure, which is what RootNavigator actually gates on.
  useEffect(() => {
    bootstrapAuth();
  }, []);

  useAutoSync();
  // AUDIO PHASE 2: bootstraps expo-audio's global audio session once, app-wide — see that hook's
  // own header for why this lives here (mirrors useAutoSync's placement) rather than in
  // ReaderScreen.
  useAudioPlayerSetup();

  // BootSplash needs its own custom fonts (Aleo/Cinzel/OpenSans) loaded to
  // render at all, so there is nothing useful to show before that — the
  // native splash screen (still up, since hideAsync above hasn't fired yet)
  // covers this gap.
  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
      {showSplash && (
        <BootSplash ready={isReady} onExited={() => setShowSplash(false)} />
      )}
    </SafeAreaProvider>
  );
}
