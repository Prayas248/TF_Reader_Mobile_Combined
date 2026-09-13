// src/components/ContentCard/ContentCard.tsx
// One publication as a row: thumbnail, a meta row (publisher, format, access
// badge), title, author line. This is the card used in the listing beneath
// the subject chips.
//
// TWO VARIANTS: `row` (default) and `cover`. A `tile` shape for a publications
// carousel was built once, then removed because nothing rendered it
// (CONVENTIONS §10 forbids a variant without a caller). CatalogueScreen's
// first-shelf carousel is now that caller, so `cover` follows §7's normal
// path: added back alongside the screen that needs it, not in advance. `cover`
// drops the chevron and action slot to stay compact as a carousel tile —
// everything else (skeleton, placeholder well, meta row, author line) works
// the same as `row`.
//
// IT NEVER DECIDES WHAT ACCESS THE USER HAS. `badge` is a slot the screen fills
// with already-resolved UI (Akriti's AccessTierBadge). Design Spec §5.1 — "the UI
// must never calculate access rights" — and CONVENTIONS §3 both forbid this card
// reading `acquisition.actionId` or `accessTier` to choose a label itself. That is
// also why this file imports nothing from `@model`: it takes strings, not a
// Publication, so it cannot reach for a field it should not interpret. `authors`
// is a plain, pre-joined string for the same reason — the screen turns
// `publication.authors` into one line, this file never sees the array.
//
// It sets no outer width, margin or position (CONVENTIONS §8) — the list that
// lays the rows out owns that.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';

import { color, elevation, radius, space, type } from '@theme/tokens';

// `error` and `offline` are deliberately absent. A single row cannot be offline
// on its own — the feed either arrived or it did not, so those belong to the
// screen that owns the request (CONVENTIONS §6).
export type ContentCardState = 'idle' | 'loading';

// `row` is the listing shape below the subject chips. `cover` is a carousel
// tile: image-forward, no action slot, no chevron. See the file header.
export type ContentCardVariant = 'row' | 'cover';

export interface ContentCardProps {
  title: string;
  // The grey line under the title — the journal or press name. Optional because
  // a publication may ship without one, and an empty grey line reads as a bug.
  publisher?: string;
  // Cover art. Absent renders a placeholder rather than failing: no fixture
  // publication carries a `thumbnailUrl`, so this is the common path today.
  imageUrl?: string;
  // The book's own file type, already derived — 'PDF', 'EPUB' or 'AUDIO'. A
  // plain string, not a ContentFormat, for the same reason `badge` is a node:
  // this file imports nothing from @model, so it cannot reach past what it is
  // handed. Optional because a `subscribe` title has no file to name.
  format?: string;
  // Credit line, pre-joined by the screen ('Joshua C. Gellers' or 'A. One,
  // B. Two'). Optional: `Publication.authors` is a real array that is
  // sometimes empty, and an empty grey line where a name should be reads as a
  // bug the same way a blank `publisher` line would.
  authors?: string;
  // A short line of real metadata ("312 pp.") shown beside `action` at the
  // foot of a row — never a fabricated field like an edition number, which
  // is why this takes a plain, already-formatted string rather than a page
  // count this file would have to word itself. Row variant only.
  meta?: string;
  // Already-resolved access UI. Never derived here — see the file header.
  badge?: ReactNode;
  /**
   * The row's access ACTION, already resolved — D12's Elite queue button.
   *
   * A SLOT, FOR THE SAME REASON `badge` IS ONE. This card must not decide that
   * an Elite title with nothing held earns a "Grant access" button; that is
   * `resolveAccess`'s answer and the screen's to render (Design Spec §5.1,
   * CONVENTIONS §3). Handing it a node keeps this file unable to reach for
   * `acquisition.actionId` even by accident — the same reason it imports nothing
   * from `@model`.
   *
   * WHY IT DOES NOT BREAK THE CARD'S OWN TAP. It renders inside the card's
   * Pressable, and a nested Pressable claims the touch itself, so the button
   * fires without also navigating. Both stay reachable to assistive tech —
   * verified, because a default-accessible Pressable CAN collapse its children
   * into one element (see the note in SignInScreen) and that would have hidden
   * this button. It does not here. Row variant only — see the file header.
   */
  action?: ReactNode;
  /**
   * A 0–1 fill toward some real denominator ("3rd of 7 in a queue"), drawn as
   * a thin track/fill bar beneath `meta`/`action`. Row variant only.
   *
   * ALREADY-DERIVED, LIKE `badge`/`action` — this card computes no fraction
   * itself (CONVENTIONS §3: it must not reach for a queue position or any
   * other business fact on its own). Absent draws no bar at all, never a
   * bar at a guessed or default fraction — LibraryScreen's own
   * `queueProgressFraction` refuses to invent a denominator for exactly
   * this reason.
   */
  progress?: number;
  state?: ContentCardState;
  variant?: ContentCardVariant;
  /**
   * Whether this card currently sits within its list's visible viewport —
   * cover variant only, ignored by `row` (see `MarqueeTitle`'s own header
   * comment for why only the cover tile needs this at all). Gates the title
   * marquee's start delay: a card the caller marks not-visible cancels any
   * pending or in-progress scroll immediately, and a freshly-visible one
   * waits out the delay again from zero. Defaults to `true`, so a caller
   * that never scrolls its cover tiles out of view (this file's own tests,
   * the dev Gallery) still gets the plain delay-then-scroll behaviour
   * without tracking anything.
   */
  visible?: boolean;
  // Absent means the row is not a navigation target, so it is not announced as a
  // button and no chevron is drawn.
  onPress?: () => void;
}

// The meta row: publisher and the format chip, whichever are present. A
// function rather than a component folder of its own — it has no
// independent identity outside this file, the same reasoning CONVENTIONS §1
// gives for a part used by only one caller.
//
// THE ACCESS BADGE DOES NOT LIVE HERE — on explicit instruction, it moved to
// the foot of the card in both variants (the row's `bottomRow`, the cover
// tile's own `badgeSlot`), so a reader scans title/author first and finds
// the access status as a closing line rather than a distraction beside the
// publisher. This row used to also take a `spread` prop purely to push that
// badge to its right edge on the cover tile; with the badge gone, `spread`
// had nothing left to spread against, so it went with it.
function MetaRow({ publisher, format }: { publisher?: string; format?: string }) {
  return (
    <View style={styles.metaRow}>
      {publisher !== undefined && (
        <Text
          testID="content-card-publisher"
          style={styles.publisher}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {publisher}
        </Text>
      )}
      {format !== undefined && (
        <View style={styles.formatChip}>
          {/* The testID sits on the Text, not this wrapper — every other
              field on this card (title, publisher, authors) puts its testID
              on the text node so `.props.children` is the plain string a test
              can compare directly, not a React element whose own accidental
              inequality prints a diff big enough to exhaust the heap. */}
          <Text testID="content-card-format" style={styles.formatChipText}>
            {format}
          </Text>
        </View>
      )}
    </View>
  );
}

// The cover tile's title is one line now (see `TITLE_LINE_HEIGHT`'s own
// note), so a long title has nowhere to wrap — this scrolls it into view
// instead of just cutting it off. Only the cover tile's title uses this: the
// row variant still wraps to two lines (its `text` column is not a fixed
// width the way a carousel tile is), so it never needs to.
//
// MEASUREMENT: the visible `Text` carries no `numberOfLines`/width of its
// own, so it lays out at its full natural width regardless of the tile —
// `onLayout` on it reports that true width, and the wrapping `marqueeClip`
// (which DOES take the tile's width) clips anything past it. This needs no
// second, hidden measuring node.
//
// TIMING: `active` (this card's own on-screen visibility, set by
// CatalogueScreen from its carousel's scroll position) gates a
// `MARQUEE_START_DELAY_MS` timer before the scroll starts — cleared by this
// effect's own cleanup the instant `active` goes false, so a tile only
// glimpsed mid-swipe never starts scrolling, and one already scrolling stops
// and resets the moment it scrolls out of view (see the return early below).
// A caller that never tracks visibility (this file's own tests, the dev
// Gallery) can simply not pass `active`; it defaults to `true` on
// `ContentCard`'s own `visible` prop, so the delay still applies, it is just
// never cancelled by visibility.
function MarqueeTitle({ text, style, active }: { text: string; style: TextStyle; active: boolean }) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [translateX] = useState(() => new Animated.Value(0));
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const overflow = textWidth - containerWidth;
  const needsMarquee = !reduceMotion && containerWidth > 0 && overflow > 0;

  useEffect(() => {
    if (!active || !needsMarquee) {
      loopRef.current?.stop();
      translateX.setValue(0);
      return;
    }

    const startTimer = setTimeout(() => {
      const legDuration = (overflow / MARQUEE_PX_PER_SEC) * 1000;
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(translateX, {
            toValue: -overflow,
            duration: legDuration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.delay(MARQUEE_END_PAUSE_MS),
          Animated.timing(translateX, {
            toValue: 0,
            duration: legDuration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.delay(MARQUEE_END_PAUSE_MS),
        ]),
      );
      loopRef.current = loop;
      loop.start();
    }, MARQUEE_START_DELAY_MS);

    return () => {
      clearTimeout(startTimer);
      loopRef.current?.stop();
      translateX.setValue(0);
    };
  }, [active, needsMarquee, overflow, translateX]);

  return (
    <View style={styles.marqueeClip} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      <Animated.Text
        testID="content-card-title"
        style={[
          style,
          styles.marqueeText,
          needsMarquee && { transform: [{ translateX }] },
        ]}
        numberOfLines={1}
        onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
      >
        {text}
      </Animated.Text>
    </View>
  );
}

export default function ContentCard({
  title,
  publisher,
  imageUrl,
  format,
  authors,
  meta,
  badge,
  action,
  progress,
  state = 'idle',
  variant = 'row',
  visible = true,
  onPress,
}: ContentCardProps) {
  const loading = state === 'loading';
  // A skeleton must not navigate: it stands in for a publication whose identity
  // the card does not know yet.
  const pressable = onPress !== undefined && !loading;
  const cover = variant === 'cover';

  // A load failure and "no cover on file" used to render identically — the
  // same grey well, no way to tell a broken fetch from a title that genuinely
  // has no artwork. One flag, held per mounted instance — every caller keys
  // a row by `publication.id`, so a different publication is a different
  // instance and starts with a clean flag rather than inheriting this one.
  const [imageFailed, setImageFailed] = useState(false);
  const showPlaceholder = imageUrl === undefined || imageFailed;

  let content: ReactNode;

  if (loading) {
    content = cover ? (
      // Mirrors the same three fixed-height slots the loaded state below
      // reserves, so nothing changes size when the real card lands.
      <View testID="content-card-skeleton" style={styles.coverSkeleton}>
        <View style={styles.coverThumb} />
        <View style={styles.metaRowSlot}>
          <View style={[styles.bar, styles.barMeta]} />
        </View>
        <View style={styles.titleSlot}>
          <View style={[styles.bar, styles.barTitle]} />
        </View>
        <View style={styles.authorSlot}>
          <View style={[styles.bar, styles.barMeta]} />
        </View>
        <View style={styles.badgeSlot}>
          <View style={[styles.bar, styles.barBadge]} />
        </View>
      </View>
    ) : (
      <View testID="content-card-skeleton" style={styles.row}>
        <View style={styles.thumb} />
        <View style={styles.text}>
          <View style={[styles.bar, styles.barMeta]} />
          <View style={[styles.bar, styles.barTitle]} />
        </View>
      </View>
    );
  } else if (cover) {
    // No action slot, no chevron — a carousel tile stays compact, and Elite's
    // queue button belongs on the detail screen only (same reason the row
    // variant never draws it on this shelf either).
    //
    // EVERY SLOT BELOW IS FIXED-HEIGHT, ALWAYS RENDERED, WHETHER OR NOT IT HAS
    // CONTENT. Side-by-side carousel tiles make an intrinsic height look like a
    // bug rather than a list's normal variation: a title that wraps to one
    // line instead of two, or a publisher/badge/author a sibling tile happens
    // to lack, would otherwise make that one tile visibly shorter than its
    // neighbours. Reserving the space regardless is what row-variant, stacked
    // vertically one at a time, never needed.
    content = (
      <>
        <View style={styles.coverImageWrap}>
          {showPlaceholder ? (
            <View
              testID="content-card-placeholder"
              style={[styles.coverThumb, styles.placeholderCenter]}
            >
              <Ionicons name="image-outline" size={ICON_SIZE} color={color.textSecondary} />
            </View>
          ) : (
            <Image
              testID="content-card-image"
              // The backend hands out a freshly-signed S3 URL (new date/signature
              // query params) on every fetch, even for the same cover — so the
              // querystring must be stripped for the cache key, or every screen's
              // signed link looks like a brand-new image to expo-image's cache.
              // Assumes the querystring carries only the signature, never a real
              // variant/version — unconfirmed by any contract doc. If the backend
              // ever encodes a genuine image variant there, two different images
              // would silently collapse onto one cache key.
              source={{ uri: imageUrl, cacheKey: imageUrl.split('?')[0] }}
              style={styles.coverThumb}
              // `contain` would letterbox a portrait cover inside a square thumb.
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={200}
              onError={() => setImageFailed(true)}
            />
          )}
          {/* Drawn over the cover art rather than in the meta row below — the
              row only has room for publisher now that the badge has moved to
              the tile's own foot (see `badgeSlot` below); the format chip
              moves here instead of competing with it for the same narrow
              width. */}
          {format !== undefined && (
            <View style={styles.coverFormatBadge}>
              <Text testID="content-card-format" style={styles.coverFormatBadgeText}>
                {format}
              </Text>
            </View>
          )}
        </View>
        <View testID="content-card-meta-slot" style={styles.metaRowSlot}>
          <MetaRow publisher={publisher} />
        </View>
        <View testID="content-card-title-slot" style={styles.titleSlot}>
          <MarqueeTitle text={title} style={styles.title} active={visible} />
        </View>
        <View testID="content-card-author-slot" style={styles.authorSlot}>
          {authors !== undefined && (
            <Text testID="content-card-authors" style={styles.authorLine} numberOfLines={1}>
              {authors}
            </Text>
          )}
        </View>
        {/* The access badge's new home — on explicit instruction, moved from
            beside the publisher (see `MetaRow`'s own note) to the tile's
            last line, so it reads as a closing status rather than
            competing with the publisher/title for attention up top.
            Fixed-height, like every slot above, for the same reason: a tile
            with no badge must not sit shorter than a neighbour that has
            one. */}
        <View testID="content-card-badge-slot" style={styles.badgeSlot}>
          {badge !== undefined && <View testID="content-card-badge">{badge}</View>}
        </View>
      </>
    );
  } else {
    content = (
      <>
        <View style={styles.thumbWrap}>
          {showPlaceholder ? (
            // A grey well, sized exactly like the image it replaces, so a list of
            // mixed cover availability stays on one baseline. The icon marks this
            // as a deliberate stand-in rather than a stalled load — see the
            // `imageFailed` note above for why "missing" and "failed" share it.
            <View
              testID="content-card-placeholder"
              style={[styles.thumb, styles.placeholderCenter]}
            >
              <Ionicons name="image-outline" size={ICON_SIZE} color={color.textSecondary} />
            </View>
          ) : (
            <Image
              testID="content-card-image"
              // The backend hands out a freshly-signed S3 URL (new date/signature
              // query params) on every fetch, even for the same cover — so the
              // querystring must be stripped for the cache key, or every screen's
              // signed link looks like a brand-new image to expo-image's cache.
              // Assumes the querystring carries only the signature, never a real
              // variant/version — unconfirmed by any contract doc. If the backend
              // ever encodes a genuine image variant there, two different images
              // would silently collapse onto one cache key.
              source={{ uri: imageUrl, cacheKey: imageUrl.split('?')[0] }}
              style={styles.thumb}
              // `contain` would letterbox a portrait cover inside a square thumb.
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={200}
              onError={() => setImageFailed(true)}
            />
          )}
          {/* `format` is real, already-derived data (never guessed from the
              tier or the id — see the file header), so this is not the card
              deciding anything: AUDIO already means "no cover art to look
              at", overlay or not, and the overlay only restates what the
              format chip beside it already says in words. */}
          {format === 'AUDIO' && (
            <View testID="content-card-play-overlay" style={styles.playOverlay}>
              <Ionicons name="play" size={type.button.size} color={color.white} />
            </View>
          )}
        </View>

        <View style={styles.text}>
          <MetaRow publisher={publisher} format={format} />
          {/* NOT a fixed-height slot, deliberately — that was tried and
              reverted. Reserving two lines' worth of height for a one-line
              title left dead space inside the box, which pushed the author
              line down by a visibly DIFFERENT amount than a two-line title
              did — an inconsistent GAP, and a more noticeable one than the
              inconsistent absolute position it replaced. The cover variant's
              own fixed slots are right for THAT shape because its tiles sit
              side by side in a horizontal carousel, where mismatched heights
              read as broken alignment between neighbours; these rows are
              stacked vertically, one at a time, the same as any feed or
              list whose items vary with their own content — `text`'s own
              `gap` below already keeps that spacing uniform. */}
          <Text testID="content-card-title" style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {authors !== undefined && (
            <Text testID="content-card-authors" style={styles.authorLine} numberOfLines={1}>
              {authors}
            </Text>
          )}
          <View style={styles.bottomSpacer} />
          {/* Beneath everything else rather than beside the chevron: the row
              already reads top-to-bottom (meta, title, author), and a 48pt
              button in the horizontal band would squeeze that column on a
              phone. The access badge moved down here too, on explicit
              instruction — see `MetaRow`'s own note — so it reads as a
              closing status line rather than competing with the publisher
              up top. `badge`+`meta` share the row's left side (`bottomRowLeft`);
              `action` stays pinned to the opposite end; any of the three can
              appear without the others. */}
          {(badge !== undefined || meta !== undefined || action !== undefined) && (
            <View style={styles.bottomRow}>
              <View style={styles.bottomRowLeft}>
                {badge !== undefined && <View testID="content-card-badge">{badge}</View>}
                {meta !== undefined && (
                  <Text testID="content-card-meta" style={styles.metaLine} numberOfLines={1}>
                    {meta}
                  </Text>
                )}
              </View>
              {action !== undefined && (
                <View testID="content-card-action" style={styles.action}>
                  {action}
                </View>
              )}
            </View>
          )}
          {progress !== undefined && (
            <View testID="content-card-progress-track" style={styles.progressTrack}>
              <View
                testID="content-card-progress-fill"
                style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
              />
            </View>
          )}
        </View>

        {pressable && <View testID="content-card-chevron" style={styles.chevron} />}
      </>
    );
  }

  const pressableNode = (
    <Pressable
      testID="content-card"
      style={[styles.card, cover && styles.cardCover]}
      onPress={pressable ? onPress : undefined}
      // `disabled`, not just a missing onPress. Clearing the handler alone leaves
      // Pressable's responder system live, so the row still reacts to touches
      // (and a test firing a press still reaches the handler). Disabling it stops
      // the responder outright, which is what a skeleton needs.
      disabled={!pressable}
      // Only a row that actually goes somewhere claims to be a button.
      accessibilityRole={pressable ? 'button' : undefined}
      accessibilityLabel={pressable ? title : undefined}
    >
      {content}
    </Pressable>
  );

  // NO SHADOW, ON PURPOSE — a lifted-object shadow was reading as noise
  // between adjacent carousel tiles rather than depth, especially with the
  // gap between tiles as tight as it was. Separation now comes from that gap
  // (CatalogueScreen's own `carousel` style) and the hairline `card` border
  // alone — the same flat, whitespace-defined treatment the row variant
  // already uses, just at the tile's own radius.
  return pressableNode;
}

// The cover tile's own width — CatalogueScreen's carousel was the first
// caller, sized wide enough that two tiles fill most of the content width
// with only a small peek of a third (see that screen's own former comment,
// now moved here). Exported so every OTHER cover-tile caller
// (PublicCatalogueScreen's and ShelfScreen's two-up grids) can size off the
// SAME number instead of a second, independently-guessed one — on explicit
// instruction that a book's cover, unchanged in ratio here, must render at
// an identical width (and therefore an identical height) everywhere in the
// app that draws a cover tile. `aspectRatio` is never overridden per
// caller for the same reason: two callers agreeing on width and ratio but
// disagreeing on width alone was the actual bug this fixes.
export const COVER_TILE_WIDTH = space.xl * 5 + space.md;

// The row thumbnail's width — the reference design's own `w-24` (96px) — and
// the chevron's box. Both are sizes rather than spacing, but they are
// composed from the spacing scale so no bare number reaches the stylesheet
// (CONVENTIONS §5).
const THUMB = space.xl * 3;
const CHEVRON = space.sm;

// The placeholder well's fallback glyph — sized against `space` for the same
// CONVENTIONS §5 reason as the two constants above, big enough to read as a
// deliberate icon rather than a stray mark in a much larger well.
const ICON_SIZE = space.xl;

// AccessTierBadge's own rendered height at size="sm": its label line
// (`type.smallLabel.lineHeight`) plus its vertical padding (`space.xs`, top
// and bottom). Shared by `badgeSlot` and its skeleton bar so both track the
// same source instead of two guessed constants.
const BADGE_HEIGHT = type.smallLabel.lineHeight + space.xs * 2;

// A deliberately smaller size than the shared `cardTitle` token, on explicit
// instruction that a book's title was reading too large on this card. A
// scoped override rather than a change to `cardTitle` itself:
// `ElitePendingAccessCard` reads that token directly too, for an unrelated
// card this instruction was not about, and shrinking the shared token would
// have moved its title along with this one. `titleSlot` and `barTitle`
// below size off this constant rather than `type.cardTitle.lineHeight`, so
// the cover tile's reserved title space shrinks along with the text that
// fills it.
const TITLE_SIZE = 16;
const TITLE_LINE_HEIGHT = 20;

// `MarqueeTitle`'s own timing — how long an overflowing title sits still
// once visible before it starts scrolling, how long it pauses at each end,
// and how fast it moves. Not derived from the spacing scale (CONVENTIONS §5
// governs layout values; these are durations/speeds, a different kind of
// constant entirely, the same exception `letterSpacing` already takes).
const MARQUEE_START_DELAY_MS = 1500;
const MARQUEE_END_PAUSE_MS = 900;
const MARQUEE_PX_PER_SEC = 40;

const styles = StyleSheet.create({
  // One horizontal band: thumb, text, chevron. `flex-start`, not `center` —
  // the thumb's fixed 2:3 ratio (96px wide, 144px tall) is reliably taller
  // than a short text column (a one-line title, no author, no meta), and
  // centering the row vertically against that tall thumb was starting the
  // title partway down the card instead of at its top edge. `chevron` below
  // opts back into centering on its own, since a decorative arrow should
  // still sit centred against the thumb regardless of how tall the text is.
  card: {
    flexDirection: 'row',
    // `stretch`, not `flex-start` — the thumb sets its own `alignSelf:
    // 'flex-start'` so it is unaffected, but `text` needs the full row
    // height so its own `bottomRow` (badge/meta/action) can anchor to the
    // row's true bottom edge via a flex spacer, the same way the cover
    // tile's badge already sits right above ITS card's own bottom edge —
    // on explicit instruction that the row variant's badge should match
    // that, not just sit at the bottom of a text column shorter than the
    // thumb beside it.
    alignItems: 'stretch',
    gap: space.md,
    // `sm`, not `xs` — on explicit instruction that the thumb/text/badge
    // were reading too close to the card's own border.
    padding: space.sm,
    backgroundColor: color.white,
    borderRadius: radius.card,
    // A hairline keeps adjacent rows separable on a white screen where the
    // shadow alone is too subtle to read.
    borderWidth: 1,
    borderColor: color.border,
    // Cropped so a cover cannot square off the card's rounded corners.
    overflow: 'hidden',
    ...(Platform.OS === 'ios' ? elevation.card.ios : elevation.card.android),
  },
  // Overrides `card`'s row axis for a carousel tile. Width is not set here —
  // the horizontal ScrollView that lays tiles out owns that (CONVENTIONS §8),
  // same as CategoryCard's strip owns its cards' width. `radius.tile` (12px)
  // matches the reference design's own tile corner exactly. No `gap` here —
  // the reference design's tile uses two different gaps (a bigger one under
  // the image, a tighter one between the meta row/title/author), so each is
  // its own margin below (`coverImageWrap`, `metaRowSlot`, `titleSlot`)
  // instead of one uniform value.
  cardCover: {
    flexDirection: 'column',
    alignItems: 'stretch',
    // `card`'s own `gap: space.md` is for the ROW variant's horizontal
    // thumb/text/chevron spacing — this switches to a column but never
    // reset it, so all 16dp leaked in as a gap between EVERY child here
    // (image, meta, title, author, badge), four times over. Found on-device
    // by colouring each slot's background and measuring the pixels between
    // them, not a guess: it was the actual reason this tile kept reading
    // too tall no matter how much the slots themselves were trimmed.
    // `xs`, not 0 — zero read as too tight once the leaked `md` gap was
    // gone entirely, so a small deliberate gap replaces the accidental
    // large one rather than leaving none at all.
    gap: space.xs,
    // Tighter than `card`'s own implicit `space.sm` reasoning would suggest —
    // this tile packs a cover, a meta row, a title and an author line into a
    // fixed width, and every side of padding is height the shelf spends on
    // whitespace rather than on being able to show a shorter, wider card.
    padding: space.xs,
    borderRadius: radius.tile,
    // Cancels `card`'s own `elevation.card` shadow rather than leaving it to
    // apply by default — see the component's return statement for why a
    // carousel tile stays flat. Zero, not omitted: RN shadow/elevation props
    // merge onto whatever `card` already set, they don't reset by absence.
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  // The skeleton reuses the card's own layout so nothing shifts when data
  // lands. `flex-start` here, unlike `card`'s own `stretch`, is fine: this
  // is a loading state with no `bottomRow` to anchor to the bottom, so
  // there is nothing for stretching the text column to accomplish yet.
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  // A book's own 2:3 ratio, not a square — matched against the reference
  // design's row card rather than stretched to fill whatever height the
  // text column happens to need. Top-aligned (`alignSelf: 'flex-start'`,
  // not `'stretch'`): a fixed-aspect cover that stretched taller than its
  // own ratio would distort.
  thumb: {
    width: THUMB,
    aspectRatio: 2 / 3,
    alignSelf: 'flex-start',
    borderRadius: radius.card,
    backgroundColor: color.border,
  },
  // Centres the fallback icon inside whichever well it is combined with
  // (`thumb` or `coverThumb`) — a layout addition only, so it composes with
  // either one's own size/ratio/radius rather than duplicating them.
  placeholderCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Gives the play-icon overlay something to measure "centred over the
  // thumbnail" against — same device as `coverImageWrap` a few styles down.
  thumbWrap: {
    position: 'relative',
    alignSelf: 'flex-start',
  },
  // Centred over the thumb rather than the whole row: it marks the ARTWORK
  // as playable, the same thing the format chip already says in words, so it
  // does not need its own tap target or accessibility role.
  playOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 34, 68, 0.4)', // Indigo (color.navy) at 40% — see coverFormatBadge's own note on why this is a raw rgba.
    borderRadius: radius.card,
  },
  // Groups the cover image with the format badge drawn over it — a plain
  // View, not `overflow: 'hidden'`, so the format badge's own corner isn't
  // clipped by the image's rounded one; `coverThumb`'s own radius already
  // keeps the IMAGE inside its rounded corner, this wrapper just gives the
  // absolutely-positioned badge something to measure "bottom-right" against.
  // No `marginBottom` — the meta row directly below is this tile's caption,
  // not a separate block, and any gap here was whitespace the "too tall"
  // complaint was actually about, not a highlight.
  coverImageWrap: {
    position: 'relative',
  },
  // The cover tile's own image well: full tile width, the row thumb's own
  // true book ratio (`2/3`) — a shorter `4/5` crop was tried here for a
  // denser card, but once real cover art was actually loading (rather than
  // the grey placeholder that had masked this) it visibly clipped real
  // covers' own top/bottom content (a publisher logo, an edition line).
  // `resizeMode="cover"` fills the box either way; this is the ratio that
  // does it with nothing cropped off a real jacket. `aspectRatio` is a
  // layout primitive, not a token value (CONVENTIONS §5's stated exceptions).
  coverThumb: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radius.card,
    backgroundColor: color.border,
  },
  // Mirrors the reference design's format tag on the book cover itself
  // rather than in the text meta row below it — see MetaRow's `spread` note.
  // A dark translucent fill over the image needs an actual alpha channel,
  // which no flat token carries, so this is a deliberate raw rgba rather than
  // a missing token (CONVENTIONS §5 governs `src/components/`'s tokens for
  // colour VALUES; there is no `color.*` entry this could be instead).
  coverFormatBadge: {
    position: 'absolute',
    right: space.xs,
    // Straddles the image's bottom edge (a negative offset, not `space.xs`
    // inset) — matches the reference design's tag sitting half on the cover,
    // half below it, rather than fully inside the image bounds.
    bottom: -space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.card,
    backgroundColor: 'rgba(0, 34, 68, 0.72)', // Indigo (color.navy) at 72% — see above.
  },
  coverFormatBadgeText: {
    fontFamily: type.cardLabel.fontFamily,
    fontSize: type.cardLabel.size,
    lineHeight: type.cardLabel.lineHeight,
    color: color.white,
  },
  // The cover skeleton's own wrapper, since `cardCover` is applied to the
  // Pressable and this needs its own testID to assert against.
  coverSkeleton: {
    flex: 1,
    gap: space.xs,
  },
  text: {
    // Takes the space left over beside the thumbnail, so a long title wraps
    // instead of pushing the chevron off the card.
    flex: 1,
    gap: space.xs,
  },
  // A flexible spacer between the top block (meta/title/author) and the
  // bottom block (`bottomRow`/`progress`) — `text` now stretches to the
  // thumb's own height (`card`'s own `alignItems: 'stretch'`), and without
  // this the bottom block would just sit under the author line with all the
  // extra height as dead space beneath it, instead of at the row's true
  // bottom edge the way `card`'s own padding already puts the thumb.
  bottomSpacer: {
    flex: 1,
  },
  // Publisher and the format chip on one line — the row variant's shape,
  // where the text column is wide enough for both left-aligned. The access
  // badge used to sit here too; see `MetaRow`'s own header note for why it
  // moved to the foot of the card instead.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  // A little more air above the action than the `xs` the text stack uses, so the
  // button reads as a separate affordance rather than a fourth line of metadata.
  // No margin of its own — it now sits inside `bottomRow`, which already
  // supplies the gap above this whole line.
  action: {},
  // `bottomRowLeft` (badge + meta) and `action` pin to opposite ends — see
  // the header comment where this is used.
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginTop: space.xs,
  },
  // The badge and the meta line share this row's left side rather than each
  // claiming a line of their own — both are short, so stacking them would
  // spend a whole extra row of height on very little text.
  bottomRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flexShrink: 1,
  },
  metaLine: {
    flexShrink: 1,
    fontFamily: type.cardMeta.fontFamily,
    fontSize: type.cardMeta.size,
    lineHeight: type.cardMeta.lineHeight,
    color: color.textSecondary,
  },
  // A queue's own colour (`wait` — Saffron, "no seats, waitlist"), not
  // `primary` — this bar exists for exactly one real caller today
  // (LibraryScreen's Elite queue row) and that caller's own fraction is a
  // wait, not a download/read-progress fill, which is what `primary` reads
  // as elsewhere in this app.
  progressTrack: {
    height: space.xs,
    marginTop: space.xs / 2,
    borderRadius: radius.pill,
    backgroundColor: color.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.wait,
  },
  // Aleo (serif) in both variants — a book's own title, not a UI label, so it
  // reads as printed rather than borrowed from the app's chrome font.
  // `TITLE_SIZE`/`TITLE_LINE_HEIGHT`, not `type.cardTitle.size`/
  // `.lineHeight` — see that constant's own comment for why this is a
  // scoped override rather than a shared-token change. `letterSpacing` is a
  // typographic value with no token group of its own, same exception
  // `formatChipText` used to take — negative, not the default 0: Aleo
  // Bold's own tracking reads as loose at this size, and a title this
  // visually important is where that shows most.
  title: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: TITLE_SIZE,
    lineHeight: TITLE_LINE_HEIGHT,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  // Open Sans Light (`cardMeta`, the same size the author line uses),
  // sentence case — whatever case the feed sent it in. The brand guide's
  // typography page lists all-caps as something to explicitly avoid
  // ("especially for paragraphs or text"), so this is deliberately NOT the
  // bold, letter-spaced, forced-uppercase chip treatment an earlier pass
  // gave it. `flexShrink` is harmless in `metaRow`, which never runs short
  // of width now that it holds only publisher and format.
  publisher: {
    flexShrink: 1,
    fontFamily: type.cardMeta.fontFamily,
    fontSize: type.cardMeta.size,
    lineHeight: type.cardMeta.lineHeight,
    color: color.textSecondary,
  },
  // The credit line under the title — same visual weight as `publisher`, its
  // own style only so the two can diverge later without one caller guessing
  // which name a shared style was really for.
  authorLine: {
    fontFamily: type.cardMeta.fontFamily,
    fontSize: type.cardMeta.size,
    lineHeight: type.cardMeta.lineHeight,
    color: color.textSecondary,
  },
  // A small, muted rect rather than a coloured pill — the format is a file
  // type, not a status, and `AccessTierBadge` already owns the pill shape for
  // things that ARE a status (open access, subscription, elite). Does not
  // shrink in the meta row, so a long badge label pushes it rather than
  // squeezing the format text into ellipsis.
  formatChip: {
    flexShrink: 0,
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    backgroundColor: color.border,
    borderRadius: radius.card,
  },
  // Open Sans — see `cardLabel`'s own note in tokens.ts for why a format
  // tag is chrome, not editorial content, and stays off Aleo.
  formatChipText: {
    fontFamily: type.cardLabel.fontFamily,
    fontSize: type.cardLabel.size,
    lineHeight: type.cardLabel.lineHeight,
    color: color.textSecondary,
  },
  // Fixed-height slots for the cover tile — see the header comment where
  // they're used. `titleSlot` reserves two full lines regardless of how many
  // the actual title needs; the others reserve one line's worth of space
  // whether or not their content is present. `metaRowSlot` additionally
  // clips: it is the one slot whose content is a ROW that could in
  // principle run wider than the tile (`metaRow`'s own header comment), and
  // a clipped edge reads as intentional where an overlapping second line
  // over the title does not.
  //
  // EACH OF THE FOUR CAPTION SLOTS BELOW ALSO CARRIES ITS OWN
  // `paddingHorizontal: space.xs`, on explicit instruction that the text and
  // the badge were reading too close to the tile's own left/right border.
  // It is added here rather than to `cardCover`'s own padding, which stays
  // untouched — widening THAT padding would also narrow the cover image
  // (`width: '100%'` of whatever `cardCover` leaves it), and the image's own
  // size is explicitly not what this instruction was about. The image
  // therefore stays flush at its original inset; only the caption column
  // sits a little further in from the edge than it does.
  metaRowSlot: {
    height: type.cardMeta.lineHeight,
    paddingHorizontal: space.xs,
    overflow: 'hidden',
    // No gap before the title — the publisher line and the title read as
    // one caption block; the real air on this tile belongs to the image
    // above, not between these two lines.
  },
  // One line, not two — see `MarqueeTitle`'s own header comment for what
  // replaced the second line: an overflowing title scrolls instead of
  // wrapping, on explicit instruction that the tile overall was reading too
  // tall.
  titleSlot: {
    height: TITLE_LINE_HEIGHT,
    paddingHorizontal: space.xs,
  },
  authorSlot: {
    height: type.cardMeta.lineHeight,
    paddingHorizontal: space.xs,
  },
  // `MarqueeTitle`'s own clip — full WIDTH OF THIS SLOT (already inset by
  // `titleSlot`'s own `paddingHorizontal` above), clipped, so its child
  // `Text` (deliberately unconstrained — see that component's own
  // "MEASUREMENT" note) can report its true natural width without also
  // spilling past the tile visually.
  marqueeClip: {
    width: '100%',
    overflow: 'hidden',
  },
  // `alignSelf: 'flex-start'`, not the parent's default `stretch` — a
  // stretched Text would be forced to the clip's own width, which is
  // exactly the width `onLayout` must NOT report if the whole measurement
  // trick is to work.
  marqueeText: {
    alignSelf: 'flex-start',
  },
  // The badge's new slot at the tile's foot — see the header comment where
  // it's used. `BADGE_HEIGHT` (not `cardMeta.lineHeight`, like the other
  // text-only slots) because this is the one slot whose real content is a
  // pill, not a text line — the same source `AccessTierBadge`'s own
  // rendered height comes from (see that constant's own comment).
  // `alignItems: 'flex-start'` keeps the pill at its own intrinsic width
  // rather than stretching it to the tile's full, wider column. No
  // `marginTop` any more — on explicit instruction that the tile overall
  // was still reading too tall even after the previous pass, and this was
  // the one remaining margin left to give back without touching the cover
  // image's own protected ratio.
  //
  // NO `marginBottom` EITHER, ANY MORE — same instruction, a later pass: it
  // used to add `space.xs` on top of `cardCover`'s own `xs` padding so the
  // badge's gap to the tile's bottom border totalled `sm` (8), matching the
  // row variant's own `card` padding. Giving that back shrinks every cover
  // tile in the app by 4px without touching the cover image's protected
  // ratio or width — the badge's bottom inset is now `xs` (4), one size
  // tighter than the row variant's, which is the accepted trade.
  badgeSlot: {
    height: BADGE_HEIGHT,
    paddingHorizontal: space.xs,
    alignItems: 'flex-start',
  },
  // Two borders on a rotated square: a chevron without an icon font, since none
  // is installed. `alignSelf: 'center'` opts back into vertical centering
  // now that `card` itself is `flex-start` — a decorative arrow should stay
  // centred against the thumb regardless of how tall the text column is.
  chevron: {
    width: CHEVRON,
    height: CHEVRON,
    alignSelf: 'center',
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: color.textSecondary,
    transform: [{ rotate: '45deg' }],
    marginRight: space.sm,
  },
  bar: {
    backgroundColor: color.border,
    borderRadius: radius.card,
  },
  // Each bar stands at the height of the line of text it replaces.
  barTitle: { height: TITLE_LINE_HEIGHT, width: '100%' },
  barMeta: { height: type.cardMeta.lineHeight, width: '60%' },
  // The cover skeleton's stand-in for the badge — same height `badgeSlot`
  // reserves for the real one, narrower than a text bar since it stands for
  // a pill rather than a line of copy.
  barBadge: { height: BADGE_HEIGHT, width: space.xl * 2 },
});
