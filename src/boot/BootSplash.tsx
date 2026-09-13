// src/boot/BootSplash.tsx
// The animated boot screen shown from first paint until the app is ready
// (fonts loaded, institution store hydrated, auth resolved). Ported from
// design/app-popup/code.html — a deliberately distinct "Orbit1" dark boot
// identity, approved as-is even though it does not match the app's real
// light TF Reader brand used everywhere else.
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
// close, and not worth a second new font dependency for two lines of
// tagline/imprint text).
//
// The mockup's blurred glow orbs (CSS `blur-*` filters) and its
// grid-backdrop are both ported for real below, not dropped: RN has no CSS
// filter blur, so each orb is approximated as concentric rings of falling
// opacity (GlowOrb) rather than a single flat-edged circle, and the grid
// lines are drawn directly rather than baked into a background image.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { radius, space, weight } from '@theme/tokens';
import { resolveFont } from '@theme/resolveFont';

// Lifted from design/app-popup/code.html's `:root` block — this screen's own
// palette, not the app's brand tokens. See file header.
const ORBIT = {
  bgDeep: '#020712',
  cyanElectric: '#00d4b4',
  // Swapped from the mockup's own '#2962ff' to the real brand's Ultramarine
  // — close enough in hue that the swap reads as a deepening, not a clash.
  ultramarine: '#003CB2',
  goldFoil: '#dfba73',
  white: '#ffffff',
} as const;

// The grid-backdrop's line grid — `background-size: 38px 38px` in the
// mockup, at the same faint blue this screen's other decorative lines use.
const GRID_SIZE = 38;
const GRID_LINE_COLOR = 'rgba(147, 197, 253, 0.042)';

// Every typeface here except the eyebrow's is a real brand font, resolved the
// same way tokens.ts does — so if OpenSans/Aleo's registered names ever
// change, this screen moves with them instead of drifting. Cinzel is the one
// deliberate exception: it carries the "Orbit1" boot identity's own eyebrow
// mark and has no equivalent in the brand's three weights.
// Per resolveFont.ts's own warning: never pair these with an explicit
// fontWeight, or Android substitutes the system typeface.
const WORDMARK_FONT = resolveFont('secondary', weight.bold); // Aleo_700Bold
const TAGLINE_FONT = resolveFont('primary', weight.light); // OpenSans_300Light
const IMPRINT_FONT = resolveFont('primary', weight.bold); // OpenSans_700Bold
const EYEBROW_FONT = 'Cinzel_600SemiBold';

// One-time intro, in ms — matches the mockup's own keyframe timings (the
// full sequence through the imprint row, the last thing to appear).
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
  top: `${number}%`;
  left: `${number}%`;
  /** True when `top`/`left` mark the orb's own centre, matching the mockup's `-translate-x/y-1/2`. */
  centered?: boolean;
  animatedOpacity?: Animated.AnimatedInterpolation<number>;
  animatedScale?: Animated.AnimatedInterpolation<number>;
}

function GlowOrb({
  diameter,
  rgb,
  baseAlpha,
  top,
  left,
  centered,
  animatedOpacity,
  animatedScale,
}: GlowOrbProps) {
  const transform = [
    ...(centered ? [{ translateX: -diameter / 2 }, { translateY: -diameter / 2 }] : []),
    ...(animatedScale ? [{ scale: animatedScale }] : []),
  ];

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top,
        left,
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
  const [eyebrow] = useState(() => new Animated.Value(0));
  const [wings] = useState(() => new Animated.Value(0));
  const [wordmark] = useState(() => new Animated.Value(0));
  const [divider] = useState(() => new Animated.Value(0));
  const [tagline] = useState(() => new Animated.Value(0));
  const [imprints] = useState(() => new Animated.Value(0));
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
      Animated.timing(eyebrow, {
        toValue: 1,
        duration: 750,
        delay: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(wings, {
        toValue: 1,
        duration: 750,
        delay: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false, // width is not supported by the native driver
      }),
      Animated.timing(wordmark, {
        toValue: 1,
        duration: 1000,
        delay: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(divider, {
        toValue: 1,
        duration: 850,
        delay: 950,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(tagline, {
        toValue: 1,
        duration: 800,
        delay: 1100,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(imprints, {
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

      {/* Just the one central glow now — the mockup's separate radial wash,
          secondary cyan glow, and static corner orb are dropped so the
          background reads as one clear ambient light rather than several
          overlapping "bubbles". */}
      <GlowOrb
        diameter={380}
        rgb="0, 60, 178"
        baseAlpha={0.14}
        top="44%"
        left="50%"
        centered
        animatedOpacity={glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.95, 0.85] })}
        animatedScale={glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.85, 1.05, 1] })}
      />

      <View style={styles.main}>
        <Animated.View
          style={[
            styles.eyebrowRow,
            {
              opacity: eyebrow,
              transform: [{ translateY: eyebrow.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
            },
          ]}
        >
          <Animated.View style={[styles.wing, { width: wings.interpolate({ inputRange: [0, 1], outputRange: [0, 34] }) }]} />
          <Text style={styles.eyebrowText}>Taylor &amp; Francis</Text>
          <Animated.View style={[styles.wing, { width: wings.interpolate({ inputRange: [0, 1], outputRange: [0, 34] }) }]} />
        </Animated.View>

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
            <Text style={styles.wordmark}>
              Orbit
              <Text style={styles.wordmarkAccent}>1</Text>
            </Text>
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

        <Animated.View
          style={[styles.divider, { width: divider.interpolate({ inputRange: [0, 1], outputRange: [0, 140] }), opacity: divider }]}
        />

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

        <Animated.View
          style={[
            styles.imprintRow,
            {
              opacity: imprints,
              transform: [{ translateY: imprints.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            },
          ]}
        >
          <Text style={styles.imprintText}>Routledge</Text>
          <View style={[styles.node, styles.nodeCyan]} />
          <Text style={styles.imprintText}>CRC Press</Text>
          <View style={[styles.node, styles.nodeBlue]} />
          <Text style={styles.imprintText}>F1000</Text>
        </Animated.View>
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
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  wing: {
    height: 1,
    backgroundColor: ORBIT.goldFoil,
    opacity: 0.7,
  },
  eyebrowText: {
    fontFamily: EYEBROW_FONT,
    fontSize: 10.5,
    letterSpacing: 3.2,
    textTransform: 'uppercase',
    color: ORBIT.goldFoil,
  },
  wordmarkWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.xs,
  },
  wordmarkClip: {
    overflow: 'hidden',
  },
  shimmerBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '60%',
  },
  wordmark: {
    fontFamily: WORDMARK_FONT,
    fontSize: 58,
    color: ORBIT.white,
  },
  wordmarkAccent: {
    fontFamily: WORDMARK_FONT,
    fontSize: 58,
    color: ORBIT.cyanElectric,
  },
  divider: {
    height: 1,
    backgroundColor: ORBIT.cyanElectric,
    marginVertical: space.md,
  },
  tagline: {
    fontFamily: TAGLINE_FONT,
    fontSize: 13,
    color: 'rgba(219, 234, 254, 0.85)',
    textAlign: 'center',
    letterSpacing: 0.3,
    maxWidth: 280,
  },
  imprintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  imprintText: {
    fontFamily: IMPRINT_FONT,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: 'rgba(224, 231, 255, 0.9)',
  },
  node: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  nodeCyan: {
    backgroundColor: ORBIT.cyanElectric,
  },
  nodeBlue: {
    backgroundColor: ORBIT.ultramarine,
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
