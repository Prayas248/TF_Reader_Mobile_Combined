// The one Filter & Sort trigger every catalogue-shaped screen renders — a
// bordered pill button, not text. PublicCatalogueScreen, ShelfScreen and
// SearchScreen all open the same FilterSortSheet from three different
// screens; this is the shared visual so all three read as one control
// instead of three screens inventing their own look for it.
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { color, elevation, radius, space, type } from '@theme/tokens';

export interface FilterSortButtonProps {
  /** Defaults to the plain trigger label; pass the "(N)" count form when filters are active. */
  label?: string;
  onPress: () => void;
  /** Falls back to a generic "Filter and sort" — override where a heading needs disambiguating (e.g. a shelf title). */
  accessibilityLabel?: string;
  testID?: string;
}

export default function FilterSortButton({
  label = 'Filter & Sort',
  onPress,
  accessibilityLabel = 'Filter and sort',
  testID,
}: FilterSortButtonProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    // A card, not a bare outline — same family as the search field and the
    // result panels below, so this reads as one designed surface next to
    // them rather than a plain HTML-style pill.
    backgroundColor: color.white,
    ...(Platform.OS === 'ios' ? elevation.card.ios : elevation.card.android),
  },
  label: {
    fontWeight: type.button.weight,
    fontFamily: type.button.fontFamily,
    fontSize: type.button.size,
    lineHeight: type.button.lineHeight,
    color: color.textPrimary,
  },
});
