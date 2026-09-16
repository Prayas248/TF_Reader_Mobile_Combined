// src/boot/BootSplash.tsx
// The animated boot screen shown from first paint until the app is ready
// (fonts loaded, institution store hydrated, auth resolved). Ported from
// design/app-popup/code.html — a deliberately distinct dark boot identity
// for the Nexus brand, kept dark on purpose even though the rest of the app
// (theme/tokens.ts) uses a light surface.
//
// NOT a shared component: it lives outside src/components/ on purpose, so it
// is not bound by CONVENTIONS.md's "no raw hex" rule. theme/tokens.ts is the
// real app's design system; this screen's palette is a one-off lifted
// straight from the mockup's own `:root` values and has no other caller.
//
// Two deliberate simplifications from the HTML mockup, both because RN has
// no direct equivalent rather than because they were judged unimportant:
//   - The wordmark's shimmer is a translucent gradient bar sweeping over the
//     text (via the already-installed expo-linear-gradient), not a
//     text-clipped gradient — RN has no `background-clip: text` without a
//     masked-view dependency this screen doesn't otherwise need.
//   - No CSS blur() on the wordmark's pop-in — RN has no filter blur for
//     Text. Scale + translateY + opacity carries the same "resolving into
//     focus" beat.
// The mockup's fake status bar ("9:41" + signal glyph) and fake iOS home
// indicator are Stitch screenshot dressing, not real UI, and are dropped —
// the OS draws its own. Body copy substitutes the app's real brand font
// (OpenSans, via resolveFont) for the mockup's Plus Jakarta Sans (visually
// close, and not worth a second new font dependency for one line of
// tagline text).
//
// The mockup's blurred glow orbs (CSS `blur-*` filters) and its
// grid-backdrop are both ported for real below, not dropped: RN has no CSS
// filter blur, so each orb is approximated as concentric rings of falling
// opacity (GlowOrb) rather than a single flat-edged circle, and the grid
// lines are drawn directly rather than baked into a background image.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { radius, space, weight } from '@theme/tokens';
import { resolveFont } from '@theme/resolveFont';

// The Nexus mark — transparent background, same asset TopAppBar uses.
const NEXUS_LOGO = require('../../assets/nexus-3.png');

// Lifted from design/app-popup/code.html's `:root` block — this screen's own
// palette, not the app's brand tokens. See file header.
const ORBIT = {
  bgDeep: '#020712',
  cyanElectric: '#00d4b4',
  white: '#ffffff',
} as const;

// The grid-backdrop's line grid — `background-size: 38px 38px` in the
// mockup, at the same faint blue this screen's other decorative lines use.
const GRID_SIZE = 38;
const GRID_LINE_COLOR = 'rgba(147, 197, 253, 0.042)';

// Every typeface here is a real brand font, resolved the same way
// tokens.ts does — so if OpenSans/Aleo's registered names ever change, this
// screen moves with them instead of drifting.
// Per resolveFont.ts's own warning: never pair these with an explicit
// fontWeight, or Android substitutes the system typeface.
const WORDMARK_FONT = resolveFont('secondary', weight.bold); // Aleo_700Bold
// Regular, not Light — Light read as too faint against the dark boot
// background for both the T&F attribution and the tagline that share this.
const TAGLINE_FONT = resolveFont('primary', weight.regular); // OpenSans_400Regular

// One-time intro, in ms — matches the mockup's own keyframe timings (the
// full sequence through the T&F watermark, the last thing to appear).
const INTRO_MS = 2400;
// The floor on how long the splash stays on screen before exit can even
// start, independent of INTRO_MS: 3500 + EXIT_FILL_MS + EXIT_FADE_MS below
// = 4000ms minimum, however fast `ready` arrives. Idles on the glow/shimmer
// loops for whatever's left over once the one-time intro itself finishes.
const MIN_VISIBLE_MS = 3500;
// The decorative progress fill holds here until `ready` actually flips true,
// since real readiness has no relationship to a fixed animation length.
const PROGRESS_HOLD = 92;
const EXIT_FILL_MS = 200;
const EXIT_FADE_MS = 300;
// Matches the mockup's `typographyShimmer 4s ... infinite`.
const SHIMMER_MS = 4000;
const SHIMMER_DELAY_MS = 1400;

// A CSS `blur()` filter has no RN equivalent, so each mockup glow — a single
// flat-colour div with a large blur radius — is approximated here as many
// concentric rings of the same colour, growing in radius as they fall off in
// opacity. Three rings (this screen's first attempt) still read as a visible
// bullseye rather than a soft blur; eight, at a shallow geometric decay, is
// where the banding stops being visible at normal viewing distance.
const GLOW_RINGS = Array.from({ length: 8 }, (_, i) => ({
  scale: 1 + i * 0.32,
  alphaMult: 0.62 ** i,
}));

interface GlowOrbProps {
  diameter: number;
  /** "r, g, b" — no `rgba(...)` wrapper, so this file can vary only the alpha per ring. */
  rgb: string;
  baseAlpha: number;
  animatedOpacity?: Animated.AnimatedInterpolation<number>;
  animatedScale?: Animated.AnimatedInterpolation<number>;
}

// Not self-positioning: a percentage `left`/`top` plus a compensating
// `translateX/Y(-diameter/2)` is exactly what CSS would do, but RN/Yoga's
// percentage resolution for an absolutely-positioned child is unreliable
// when the parent's own width comes from flex/stretch rather than an
// explicit number — which `main` (the caller) is. Plain flexbox centering
// has no such edge case, so GlowOrb only renders its own sized box and
// leaves centering to a `alignItems/justifyContent: 'center'` wrapper.
function GlowOrb({ diameter, rgb, baseAlpha, animatedOpacity, animatedScale }: GlowOrbProps) {
  const transform = animatedScale ? [{ scale: animatedScale }] : [];

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        width: diameter,
        height: diameter,
        opacity: animatedOpacity ?? 1,
        transform,
      }}
    >
      {GLOW_RINGS.map(({ scale, alphaMult }) => (
        <View
          key={scale}
          style={{
            position: 'absolute',
            top: (diameter - diameter * scale) / 2,
            left: (diameter - diameter * scale) / 2,
            width: diameter * scale,
            height: diameter * scale,
            borderRadius: radius.pill,
            backgroundColor: `rgba(${rgb}, ${baseAlpha * alphaMult})`,
          }}
        />
      ))}
    </Animated.View>
  );
}

// The grid half of the mockup's `grid-backdrop` — a static line grid, drawn
// directly rather than baked into a tiled background image. Line count is
// derived from the window so it always fills the screen without gaps.
function GridBackdrop() {
  const { width, height } = useWindowDimensions();
  const columns = useMemo(() => Math.ceil(width / GRID_SIZE) + 1, [width]);
  const rows = useMemo(() => Math.ceil(height / GRID_SIZE) + 1, [height]);

  return (
    <View style={styles.gridLayer} pointerEvents="none">
      {Array.from({ length: columns }, (_, i) => (
        <View key={`v${i}`} style={[styles.gridLineV, { left: i * GRID_SIZE }]} />
      ))}
      {Array.from({ length: rows }, (_, i) => (
        <View key={`h${i}`} style={[styles.gridLineH, { top: i * GRID_SIZE }]} />
      ))}
    </View>
  );
}

export interface BootSplashProps {
  /** The real app has finished booting (fonts, hydration, auth). */
  ready: boolean;
  /** The exit fade has finished; safe to stop rendering this component. */
  onExited: () => void;
}

export default function BootSplash({ ready, onExited }: BootSplashProps) {
  const [glow] = useState(() => new Animated.Value(0));
  const [wordmark] = useState(() => new Animated.Value(0));
  const [tagline] = useState(() => new Animated.Value(0));
  const [tfMark] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(0));
  const [shimmer] = useState(() => new Animated.Value(0));
  const [exitOpacity] = useState(() => new Animated.Value(1));

  // Loops started by the intro sequence, stopped on exit — kept in a ref
  // rather than re-derived, so the exit effect can reach the exact same
  // Animated.CompositeAnimation instances.
  const loopsRef = useRef<Animated.CompositeAnimation[]>([]);

  // When the intro started, so the ready-effect can work out how much of it
  // is still left to play rather than cutting it short.
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    Animated.parallel([
      Animated.timing(glow, {
        toValue: 1,
        duration: INTRO_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(wordmark, {
        toValue: 1,
        duration: 1000,
        delay: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(tfMark, {
        toValue: 1,
        duration: 800,
        delay: 1100,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(tagline, {
        toValue: 1,
        duration: 800,
        delay: 1300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(progress, {
        toValue: PROGRESS_HOLD,
        duration: INTRO_MS,
        delay: 500,
        easing: Easing.bezier(0.2, 0.8, 0.2, 1),
        useNativeDriver: false, // width is not supported by the native driver
      }),
    ]).start();

    const shimmerLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, {
          toValue: 1,
          duration: SHIMMER_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(shimmer, {
          toValue: 0,
          duration: 0,
          delay: SHIMMER_DELAY_MS,
          useNativeDriver: true,
        }),
      ]),
    );
    shimmerLoop.start();

    loopsRef.current = [shimmerLoop];

    return () => {
      loopsRef.current.forEach((loop) => loop.stop());
    };
    // Intro is a fire-once sequence — deliberately no deps, so remounting
    // this component is the only thing that ever replays it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;

    // Never exits before MIN_VISIBLE_MS, even on a warm boot where `ready`
    // arrives almost immediately. Only the remainder is waited out here; a
    // slow boot that already outran it exits straight away.
    const elapsed = Date.now() - mountedAt;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);

    const timer = setTimeout(() => {
      loopsRef.current.forEach((loop) => loop.stop());

      Animated.sequence([
        Animated.timing(progress, {
          toValue: 100,
          duration: EXIT_FILL_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(exitOpacity, {
          toValue: 0,
          duration: EXIT_FADE_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) onExited();
      });
    }, remaining);

    return () => clearTimeout(timer);
  }, [ready, mountedAt, progress, exitOpacity, onExited]);

  const shimmerTranslateX = shimmer.interpolate({ inputRange: [0, 1], outputRange: ['-60%', '160%'] });

  return (
    <Animated.View
      testID="boot-splash"
      style={[styles.stage, { opacity: exitOpacity }]}
      pointerEvents="none"
    >
      <GridBackdrop />

      <View style={styles.main}>
        {/* Just the one central glow now — the mockup's separate radial wash,
            secondary cyan glow, and static corner orb are dropped so the
            background reads as one clear ambient light rather than several
            overlapping "bubbles". Filling and centered on `main` itself
            (not `stage`) — the same box the content column centers in — so
            the glow tracks the content instead of a hardcoded fraction of
            the full screen. */}
        <View style={styles.glowLayer} pointerEvents="none">
          <GlowOrb
            diameter={380}
            rgb="0, 60, 178"
            baseAlpha={0.14}
            animatedOpacity={glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.95, 0.85] })}
            animatedScale={glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.85, 1.05, 1] })}
          />
        </View>

        <Animated.View
          style={[
            styles.wordmarkWrap,
            {
              opacity: wordmark,
              transform: [
                { scale: wordmark.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
                { translateY: wordmark.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
              ],
            },
          ]}
        >
          <View style={styles.wordmarkClip}>
            <Image source={NEXUS_LOGO} style={styles.nexusMark} resizeMode="contain" />
            <Text style={styles.wordmark}>Nexus</Text>
            {/* Stand-in for the mockup's text-clipped gradient shimmer — see
                file header for why this is a sweeping bar rather than a
                clip. */}
            <Animated.View
              pointerEvents="none"
              style={[styles.shimmerBar, { transform: [{ translateX: shimmerTranslateX }] }]}
            >
              <LinearGradient
                colors={['transparent', 'rgba(255, 255, 255, 0.35)', 'transparent']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </View>
        </Animated.View>

        {/* Small T&F attribution, centered under the Nexus lockup — a
            watermark, not a second brand. */}
        <Animated.Text
          style={[
            styles.tfMark,
            {
              opacity: tfMark,
              transform: [{ translateY: tfMark.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
            },
          ]}
        >
          by Taylor &amp; Francis Group
        </Animated.Text>

        <Animated.Text
          style={[
            styles.tagline,
            {
              opacity: tagline,
              transform: [{ translateY: tagline.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            },
          ]}
        >
          One Destination. The Global Publishing Ecosystem.
        </Animated.Text>
      </View>

      <View style={styles.footer}>
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressFill,
              { width: progress.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) },
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: ORBIT.bgDeep,
    zIndex: 999,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  gridLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: GRID_LINE_COLOR,
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: GRID_LINE_COLOR,
  },
  main: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  // Fills `main` exactly and centers GlowOrb on it with plain flexbox —
  // see GlowOrb's own comment for why this replaced a percentage `left`/`top`.
  glowLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmarkWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.xs,
  },
  wordmarkClip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    overflow: 'hidden',
  },
  shimmerBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '60%',
  },
  nexusMark: {
    width: 56,
    height: 56,
  },
  wordmark: {
    fontFamily: WORDMARK_FONT,
    fontSize: 52,
    color: ORBIT.white,
  },
  tagline: {
    fontFamily: TAGLINE_FONT,
    fontSize: 13,
    color: 'rgba(219, 234, 254, 0.85)',
    textAlign: 'center',
    letterSpacing: 0.3,
    maxWidth: 280,
  },
  // The small T&F attribution — centered under the Nexus lockup, small
  // enough to stay secondary but legible enough to actually be read.
  tfMark: {
    alignSelf: 'center',
    marginTop: -8,
    marginBottom: space.lg,
    fontFamily: TAGLINE_FONT,
    fontSize: 12,
    letterSpacing: 0.3,
    color: 'rgba(219, 234, 254, 0.85)',
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
  },
  progressTrack: {
    width: 224,
    height: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: ORBIT.cyanElectric,
  },
});
