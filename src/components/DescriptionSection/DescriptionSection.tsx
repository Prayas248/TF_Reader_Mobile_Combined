// src/components/DescriptionSection/DescriptionSection.tsx
// A real, structural section — always rendered, in one of two states: the
// feed's own description, verbatim, or an honest "not available yet" line
// when the field is genuinely absent. Never omitted outright, on explicit
// instruction: a screen deciding for itself which values count as "real"
// description text is exactly the judgement call this component avoids —
// render what came back.
//
// Extracted from ItemDetailScreen.tsx (screen 05's "About this title") so
// JournalScreen's "About this journal" (screen 02) shares the exact same
// clamp/"Read more" behaviour rather than a second copy of it. Screen 04's
// "Abstract" is a DIFFERENT, simpler shape on purpose — no clamp, no
// fallback line, hidden entirely when absent — and stays inline in
// ItemDetailScreen.tsx rather than moving here.
import { useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SectionHeader } from '@components/SectionHeader';
import { color, space, type as typeScale } from '@theme/tokens';

// Lines shown before "Read more" appears.
const DESCRIPTION_CLAMP_LINES = 4;
// A rough proxy for "long enough to likely exceed the clamp" — approximated by
// length rather than a measure-then-clamp render pass (RN's `onTextLayout`
// reports the CLAMPED line count while `numberOfLines` is already set, so
// measuring accurately needs an extra unclamped render first). Good enough for
// "does 'Read more' need to exist at all", not pretending to be an exact line
// count.
const DESCRIPTION_LONG_THRESHOLD = 220;

export interface DescriptionSectionProps {
  /** The section heading — "About this title", "About this journal". */
  title: string;
  description?: string;
  /** Shown in place of the description when it is absent. */
  unavailableLabel?: string;
}

export function DescriptionSection({
  title,
  description,
  unavailableLabel = 'Description not available yet.',
}: DescriptionSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const long = description !== undefined && description.length > DESCRIPTION_LONG_THRESHOLD;

  return (
    <View style={styles.sectionBlock}>
      <SectionHeader title={title} />
      {description !== undefined ? (
        <>
          <Text
            style={styles.description}
            numberOfLines={!expanded && long ? DESCRIPTION_CLAMP_LINES : undefined}
          >
            {description}
          </Text>
          {long && (
            <Pressable
              onPress={() => setExpanded((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Show less' : 'Read more'}
            >
              <Text style={styles.readMoreLabel}>{expanded ? 'Show less' : 'Read more'}</Text>
            </Pressable>
          )}
        </>
      ) : (
        <Text style={styles.descriptionUnavailable}>{unavailableLabel}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionBlock: {
    gap: space.xs,
    marginTop: space.sm,
  },
  description: {
    alignSelf: 'stretch',
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textPrimary,
  },
  readMoreLabel: {
    marginTop: space.xs,
    fontFamily: typeScale.button.fontFamily,
    fontSize: typeScale.button.size,
    lineHeight: typeScale.button.lineHeight,
    color: color.primary,
  },
  descriptionUnavailable: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
});
