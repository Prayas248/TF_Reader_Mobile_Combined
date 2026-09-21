// The app's one full-screen "please wait" surface — for a genuine blocking
// gate before a screen mounts (nothing else on screen underneath it), not for
// a spinner embedded alongside other content. For that, use Spinner directly.
//
// NOT BootSplash: BootSplash is the one-time, deliberately distinct dark boot
// identity, ported straight from a mockup and explicitly not bound to
// theme/tokens.ts (see its own header). This is the ordinary in-app loader,
// styled from the real brand tokens, for every other wait.
//
// The rotating line exists for the same reason Myntra/similar apps rotate
// copy during a wait: a static "Loading…" reads slower than it is. Real,
// attributed quotes about books and knowledge, one at a time, fading in
// place — not invented flavour text, and not a generic "Loading…".
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';

import { color, space, type } from '@theme/tokens';

import AnimatedLogo from './AnimatedLogo';

export interface LoaderProps {
  /**
   * An optional context line above the rotating quote — e.g. a book's own
   * title while it opens. Absent means the quote carries the whole message.
   */
  title?: string;
  testID?: string;
}

interface Quote {
  text: string;
  author: string;
}

// Eighteen. Seven have a real, checkable tie to Taylor & Francis's own
// publishing history rather than just the theme of "books": Russell,
// Wittgenstein, Popper (x2) and Mill are all in print today under Routledge
// Classics (Routledge is a T&F imprint); Freud's "Dreams are the royal road"
// is from The Interpretation of Dreams, part of the Standard Edition of his
// works Routledge publishes; and Faraday's papers ran in T&F's own
// Philosophical Magazine (founded 1798, still publishing) — that is T&F's
// own history, not an imprint's. The rest (Bacon x2, Descartes, Cicero,
// Confucius, Emerson, Twain, Borges, Aristotle, Socrates, Dr. Seuss) are
// widely-attributed, easily-verified quotes about books/knowledge with no
// specific T&F link, kept for variety rather than presented as house history.
const QUOTES: readonly Quote[] = [
  { text: 'Knowledge is power.', author: 'Francis Bacon' },
  {
    text: 'Some books are to be tasted, others to be swallowed, and some few to be chewed and digested.',
    author: 'Francis Bacon',
  },
  {
    text: 'The reading of all good books is like a conversation with the finest minds of past centuries.',
    author: 'René Descartes',
  },
  { text: 'A room without books is like a body without a soul.', author: 'Cicero' },
  { text: 'Real knowledge is to know the extent of one’s ignorance.', author: 'Confucius' },
  {
    text: 'Philosophy is to be studied, not for the sake of any definite answers, but rather for the sake of the questions themselves.',
    author: 'Bertrand Russell, The Problems of Philosophy',
  },
  {
    text: 'The limits of my language mean the limits of my world.',
    author: 'Ludwig Wittgenstein, Tractatus Logico-Philosophicus',
  },
  {
    text: 'Science may be described as the art of systematic over-simplification.',
    author: 'Karl Popper',
  },
  {
    text: 'He who knows only his own side of the case, knows little of that.',
    author: 'John Stuart Mill, On Liberty',
  },
  {
    text: 'Nothing is too wonderful to be true, if it be consistent with the laws of nature.',
    author: 'Michael Faraday',
  },
  {
    text: 'Dreams are the royal road to the unconscious.',
    author: 'Sigmund Freud, The Interpretation of Dreams',
  },
  {
    text: 'Our knowledge can only be finite, while our ignorance must necessarily be infinite.',
    author: 'Karl Popper, Conjectures and Refutations',
  },
  {
    text: 'I cannot remember the books I’ve read any more than the meals I have eaten; even so, they have made me.',
    author: 'Ralph Waldo Emerson',
  },
  {
    text: 'The man who does not read has no advantage over the man who cannot read.',
    author: 'Mark Twain',
  },
  { text: 'I have always imagined that Paradise will be a kind of library.', author: 'Jorge Luis Borges' },
  {
    text: 'It is the mark of an educated mind to be able to entertain a thought without accepting it.',
    author: 'Aristotle',
  },
  {
    text: 'Employ your time in improving yourself by other men’s writings, so that you shall gain easily what others have labored hard for.',
    author: 'Socrates',
  },
  { text: 'The more that you read, the more things you will know.', author: 'Dr. Seuss' },
];

const QUOTE_INTERVAL_MS = 12_000;
const FADE_MS = 250;
// Caps how many lines the quote/author pair may ever take, and reserves
// exactly that much height below — see QUOTE_BLOCK_HEIGHT. Without a fixed
// slot, a two-line quote following a one-line one grows the centered flex
// column and visibly shoves the logo (and title, if present) upward on every
// rotation; a fixed, worst-case slot keeps everything above it static and
// only re-centers the text WITHIN its own reserved space.
const QUOTE_MAX_LINES = 4;
const AUTHOR_MAX_LINES = 2;
const QUOTE_BLOCK_HEIGHT =
  type.body.lineHeight * QUOTE_MAX_LINES + space.xs + type.smallLabel.lineHeight * AUTHOR_MAX_LINES;
// How long the whole screen takes to settle in — every call site swaps this
// in the instant a gate flips (a promise resolving, a route mounting), which
// reads as a hard cut without something here to soften the arrival.
const ENTRANCE_MS = 300;
const ENTRANCE_RISE = 12;

// A random index in [0, length) that is NEVER `excluding` — picked as an
// offset from the current index rather than by re-rolling until it differs,
// so it is always exactly one Math.random() call (a naive reject-and-retry
// loop can spin forever if something upstream ever pins Math.random to a
// single value, e.g. under test).
function nextQuoteIndex(excluding: number, length: number): number {
  if (length <= 1) return 0;
  const offset = 1 + Math.floor(Math.random() * (length - 1));
  return (excluding + offset) % length;
}

export default function Loader({ title, testID }: LoaderProps) {
  // Randomised on mount too, not just between rotations — otherwise every
  // single open of this screen would lead with the same quote.
  const [quoteIndex, setQuoteIndex] = useState(() => Math.floor(Math.random() * QUOTES.length));
  const [opacity] = useState(() => new Animated.Value(0));
  const [entrance] = useState(() => new Animated.Value(0));

  // Which quote is showing is driven by a plain interval — deterministic
  // under fake timers. The fade is a separate, fire-and-forget animation keyed
  // off the index change rather than chained through the interval's own
  // callback, so a slow/queued animation frame can never drift the schedule
  // that decides WHEN the next quote appears.
  useEffect(() => {
    const timer = setInterval(() => {
      setQuoteIndex((current) => nextQuoteIndex(current, QUOTES.length));
    }, QUOTE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_MS,
      useNativeDriver: true,
    }).start();
  }, [quoteIndex, opacity]);

  // Runs once, on mount only — this is the screen's own arrival, not tied to
  // the quote rotation above.
  useEffect(() => {
    Animated.timing(entrance, {
      toValue: 1,
      duration: ENTRANCE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.container,
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [ENTRANCE_RISE, 0] }) },
          ],
        },
      ]}
      accessibilityRole="progressbar"
      accessibilityLabel={title ?? 'Loading'}
    >
      <AnimatedLogo />
      {title !== undefined && (
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
      )}
      <Animated.View style={[styles.quoteBlock, { opacity }]}>
        <Text style={styles.quote} numberOfLines={QUOTE_MAX_LINES} testID="loader-quote">
          “{QUOTES[quoteIndex].text}”
        </Text>
        <Text style={styles.author} numberOfLines={AUTHOR_MAX_LINES} testID="loader-author">
          — {QUOTES[quoteIndex].author}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.white,
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  title: {
    fontWeight: type.sectionHeader.weight,
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
    textAlign: 'center',
  },
  // Fixed height, regardless of which quote is showing — see
  // QUOTE_BLOCK_HEIGHT's own comment. Centering the (usually shorter) real
  // content inside this fixed slot is what keeps a short quote from reading
  // as oddly top-heavy within the reserved space.
  quoteBlock: {
    height: QUOTE_BLOCK_HEIGHT,
    justifyContent: 'center',
  },
  quote: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textSecondary,
    textAlign: 'center',
  },
  author: {
    fontWeight: type.smallLabel.weight,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: space.xs,
  },
});
