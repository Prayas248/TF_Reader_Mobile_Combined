// src/components/SearchInput/SearchInput.tsx
// The one search field for BOTH search surfaces — catalogue (screens 01, 09) and
// institution (screen 06). Foundation Spec §6.5: the two pipelines differ on
// corpus, criticality and offline behaviour, but they share a single input.
//
// IT HOLDS NO QUERY STATE AND RUNS NO SEARCH. `value` in, `onChangeText` out — a
// controlled input. Debouncing, tokenising, ranking and fetching belong to the
// pipeline that owns the query (CONVENTIONS §3). Focus is still this
// component's own local state for styling purposes — `onFocus`/`onBlur` below
// are an optional bubble-up for a caller that needs to react to it (e.g. a
// suggestions dropdown), not a transfer of ownership.
//
// THE MIC IS OPT-IN, VIA `onVoicePress` RATHER THAN A BOOLEAN. Voice (B11) is
// catalogue-scoped only, so institution search must not show it. There is no
// `showVoice` flag because a caller that wants the icon needs somewhere to send
// the press anyway — one prop cannot then contradict the other.
//
// It sets no outer margin, width or position (CONVENTIONS §8) — the search shell
// that lays it out owns that. That includes the design's overlap onto the navy
// header: a negative top margin belongs to the screen, not to this file.
//
// ONE THING THE DESIGN ASKS FOR THAT THE TOKENS CANNOT GIVE. The reference shows
// a WHITE card on a grey page. `tokens.ts` has no white — `color.surface` is
// #F8F9FA and is already the page background, so card and page are the same
// colour here and only the shadow and hairline separate them. CONVENTIONS §5
// says to raise a missing token rather than invent one, so this is raised for
// Khushi (tokens are single-authored) and not worked around locally.
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { color, elevation, radius, space, type } from '@theme/tokens';

// A raised card rather than a boxed input, so it can sit over the navy header
// the way the design shows. 56 is the card's own height — comfortably above the
// 44pt minimum touch target, and tall enough that the elevation reads as depth
// instead of a smudge. A bare number in the StyleSheet would fail CONVENTIONS
// §5, so it is named here — same approach as TopAppBar's BAR_HEIGHT.
const FIELD_HEIGHT = 56;

// Leading and trailing glyphs. Sized up from the surrounding body text so the
// field reads as a control, not a line of copy.
const ICON_SIZE = 22;

// ─── Props ───────────────────────────────────────────────────────────────────

// `loading`, `empty` and `error` are deliberately absent. All three describe the
// RESULTS of a search, not the box you type into — they belong to the list the
// pipeline renders (CONVENTIONS §6). `offline` is here because Design Spec §4.2
// requires search to stay usable behind the banner, so the field has to say so
// without locking the reader out.
export type SearchInputState = 'idle' | 'offline';

export interface SearchInputProps {
  /** The query text. Controlled — the pipeline owns it, never this component. */
  value: string;
  /** Prompt shown while the field is empty. */
  placeholder?: string;
  /** Every keystroke. The pipeline decides whether to debounce it. */
  onChangeText: (text: string) => void;
  /** Return key pressed. Absent means the keyboard's search key does nothing. */
  onSubmit?: () => void;
  /**
   * The clear (×) affordance was pressed. The field is emptied through
   * `onChangeText('')` either way; this fires alongside so a pipeline can also
   * drop its results rather than re-running a search for the empty string.
   */
  onClear?: () => void;
  /** Presence renders the mic. Catalogue search only — see the file header. */
  onVoicePress?: () => void;
  /** Lifecycle. `offline` stays typeable — degraded, not blocked. */
  state?: SearchInputState;
  /** Not typeable, and the trailing controls are withdrawn. */
  disabled?: boolean;
  /** The field gained focus. Optional — a bubble-up of this component's own focus state. */
  onFocus?: () => void;
  /** The field lost focus. Optional — same bubble-up as `onFocus`. */
  onBlur?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SearchInput({
  value,
  placeholder = 'Search',
  onChangeText,
  onSubmit,
  onClear,
  onVoicePress,
  state = 'idle',
  disabled = false,
  onFocus,
  onBlur,
}: SearchInputProps) {
  // Focus is the one piece of state a controlled input may hold: it is the
  // presentation of an interaction, not knowledge about the query.
  const [focused, setFocused] = useState(false);

  const offline = state === 'offline';
  // "Filled" is derived, never a prop — two sources for one fact drift apart.
  const filled = value.length > 0;

  const handleClear = () => {
    onChangeText('');
    onClear?.();
  };

  return (
    <View
      testID="search-input"
      style={[
        styles.field,
        focused && styles.fieldFocused,
        disabled && styles.fieldDisabled,
      ]}
    >
      {/* Leading — swaps to the offline glyph so the state is visible without a
          second row of chrome stealing height from the results. */}
      <Ionicons
        testID={offline ? 'search-input-offline-icon' : 'search-input-icon'}
        name={offline ? 'cloud-offline-outline' : 'search'}
        size={ICON_SIZE}
        color={disabled ? color.textSecondary : color.navy}
        style={styles.leadingIcon}
      />

      <TextInput
        testID="search-input-field"
        style={styles.input}
        value={value}
        placeholder={placeholder}
        placeholderTextColor={color.textSecondary}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        editable={!disabled}
        returnKeyType="search"
        // A query is not prose. Autocorrecting a surname into a dictionary word
        // makes the corpus unsearchable for exactly the proper nouns people
        // search for, and the reader rarely notices it happened.
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel={placeholder}
        accessibilityState={{ disabled }}
      />

      {/* Trailing — clear and mic are independent affordances and may appear
          together. Hiding the mic once text exists would quietly remove voice
          from every query a reader wants to amend; that is a product call, not
          a styling one, so both render and it goes to the first demo. */}
      {filled && !disabled && (
        <Pressable
          testID="search-input-clear"
          onPress={handleClear}
          hitSlop={space.sm}
          style={styles.trailingButton}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Ionicons name="close-circle" size={ICON_SIZE} color={color.textSecondary} />
        </Pressable>
      )}

      {onVoicePress && !disabled && (
        <Pressable
          testID="search-input-voice"
          onPress={onVoicePress}
          hitSlop={space.sm}
          style={styles.trailingButton}
          accessibilityRole="button"
          accessibilityLabel="Search by voice"
        >
          <Ionicons name="mic-outline" size={ICON_SIZE} color={color.navy} />
        </Pressable>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  field: {
    height: FIELD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.white,
    // The hairline stays even though the design shows none. Without a white
    // token the card and the page behind it are the SAME colour (both
    // `surface`), so the shadow alone is not enough separation — and the border
    // is also what turns teal on focus. See the note in the file header.
    borderWidth: 1,
    borderColor: color.border,
    // The 16 step, not the 8 card step — the softer corner is what makes this
    // read as a raised search card rather than a boxed form field.
    borderRadius: radius.sheet,
    paddingHorizontal: space.md,
    // `elevation.raised`, not `.card` — this field is Search's own equivalent
    // of the Catalogue hero: the one surface on the screen meant to look
    // lifted off the page, not merely separated from it (see that token's own
    // header comment in tokens.ts). `.card`'s subtle shadow read as barely
    // there against a white page, which was the actual "basic" complaint.
    ...(Platform.OS === 'ios' ? elevation.raised.ios : elevation.raised.android),
  },
  fieldFocused: {
    borderColor: color.primary,
  },
  fieldDisabled: {
    backgroundColor: color.border,
  },
  leadingIcon: {
    marginRight: space.sm,
  },
  input: {
    flex: 1,
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
    // Android gives a TextInput generous default vertical padding; zeroing it
    // keeps the text on the same baseline as the icons either side of it.
    paddingVertical: 0,
  },
  trailingButton: {
    marginLeft: space.sm,
  },
});
