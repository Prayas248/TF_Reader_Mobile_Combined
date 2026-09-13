import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { color, space, type } from '@theme/tokens';

// `static` added for ProfileScreen's Sept 2026 redesign: a row that carries
// real information (an icon, a title, a subtitle) but has no destination and
// is not a "disabled" version of an actionable row — there was never an
// action to disable. `disabled` on the other variants still means "normally
// actionable, greyed because nothing is behind it right now"; `static` means
// "this was never actionable to begin with", and the two must not look alike
// (see that variant's own render branch for why it skips Pressable entirely).
export type ListRowVariant = 'chevron' | 'toggle' | 'value' | 'destructive' | 'static';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  variant: ListRowVariant;
  toggleValue?: boolean;
  onToggleChange?: (value: boolean) => void;
  valueText?: string;
  onPress?: () => void;
  /**
   * The row exists but cannot be actioned — nothing behind it yet.
   *
   * SHOWN, NOT HIDDEN, and the same reasoning as `FilterChip`'s own `disabled`:
   * removing the row makes the list look complete when it is not, and the
   * reader never learns the setting is coming. A greyed row that announces
   * itself as disabled is the honest version, and it cannot pretend to perform
   * an action that has no destination.
   *
   * Not read at all for `variant="static"` — that variant is never Pressable
   * in the first place, so there is no press affordance to grey out.
   */
  disabled?: boolean;
  /**
   * Swaps the title/subtitle family to Aleo — added for ProfileScreen's
   * Sept 2026 redesign, the only caller that wants it. Defaults to `false`,
   * so `AccessibilityScreen` and `ReaderPreferencesScreen` render exactly as
   * before. Same shape as `SectionHeader`'s own `emphasis` prop, for the same
   * reason: one caller's font choice should not move for every other one.
   */
  emphasis?: 'default' | 'editorial';
}

export default function ListRow({
  title,
  subtitle,
  icon,
  variant,
  toggleValue = false,
  onToggleChange,
  valueText,
  onPress,
  disabled = false,
  emphasis = 'default',
}: ListRowProps) {
  const isDestructive = variant === 'destructive';
  const isEditorial = emphasis === 'editorial';

  function handlePress() {
    if (variant === 'toggle') {
      onToggleChange?.(!toggleValue);
    } else {
      onPress?.();
    }
  }

  // A PLAIN View, NOT A DISABLED Pressable. A Pressable with no handler and
  // `disabled` still exposes itself to a screen reader as a focus stop with
  // no label to justify stopping there — the same "fake affordance" trap
  // ProfileScreen.tsx's own header note names for a chevron with nothing
  // behind it. Informational content that was never actionable gets no
  // press semantics of any kind, and it is drawn at full opacity: `disabled`
  // exists to grey a row that WOULD do something if it could, and that is
  // not this row's story.
  if (variant === 'static') {
    return (
      <View style={styles.row}>
        {icon !== undefined && <View style={styles.leadingIcon}>{icon}</View>}

        <View style={styles.content}>
          <Text style={[styles.title, isEditorial && styles.titleEditorial]}>{title}</Text>
          {subtitle !== undefined && (
            <Text style={[styles.subtitle, isEditorial && styles.subtitleEditorial]}>
              {subtitle}
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <Pressable
      style={[styles.row, disabled && styles.rowDisabled]}
      onPress={handlePress}
      // `disabled`, not just a withheld `onPress`. Clearing the handler alone
      // leaves the row pressable and announced as an enabled button, which is
      // exactly the pretence this prop exists to stop — same call ContentCard
      // and CategoryCard already make.
      disabled={disabled}
      accessibilityRole={variant === 'toggle' ? 'switch' : 'button'}
      accessibilityLabel={title}
      accessibilityState={
        variant === 'toggle' ? { checked: toggleValue, disabled } : { disabled }
      }
    >
      {icon !== undefined && (
        <View style={styles.leadingIcon}>{icon}</View>
      )}

      <View style={styles.content}>
        <Text
          style={[
            styles.title,
            isEditorial && styles.titleEditorial,
            isDestructive && styles.titleDestructive,
          ]}
        >
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text style={[styles.subtitle, isEditorial && styles.subtitleEditorial]}>
            {subtitle}
          </Text>
        )}
      </View>

      {variant === 'chevron' && (
        <Ionicons name="chevron-forward" size={20} color={color.textSecondary} />
      )}
      {variant === 'toggle' && (
        <Switch
          value={toggleValue}
          onValueChange={onToggleChange}
          // The Switch is its own touch target inside the row, so the
          // Pressable's `disabled` does not reach it. Without this line a
          // disabled row still flips.
          disabled={disabled}
          trackColor={{ false: color.border, true: color.primary }}
          thumbColor={color.white}
        />
      )}
      {variant === 'value' && valueText !== undefined && (
        <Text style={styles.valueText}>{valueText}</Text>
      )}
    </Pressable>
  );
}

// Minimum touch target composed from the spacing scale — no bare number.
const ROW_HEIGHT = space.xl + space.md;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: ROW_HEIGHT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    gap: space.md,
  },
  // `space.xl`, not `space.lg` — matches the width of the icon-chip container
  // callers like ProfileScreen's `rowIcon()` wrap their icons in. A narrower
  // slot let that chip overflow it and swallow the row's own `gap`, so the
  // icon and title rendered with almost no space between them.
  leadingIcon: {
    width: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: space.xs,
  },
  title: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  titleDestructive: {
    color: color.error,
  },
  // Family only — size/lineHeight/colour stay `title`'s own. `fontWeight` is
  // explicitly cleared: `title` sets one for Open Sans (safe — Open Sans Bold
  // reads as Android's own system Roboto Bold, see resolveFont.ts's own
  // warning), and a custom Aleo family paired with a leftover `fontWeight`
  // is the exact substitution bug that comment names. `type.cardTitle`
  // supplies Aleo already at bold weight, so nothing is lost by clearing it.
  titleEditorial: {
    fontFamily: type.cardTitle.fontFamily,
    fontWeight: undefined,
  },
  // Permitted by CONVENTIONS §5 as a layout primitive — opacity is the exception
  // to "no bare numbers", which is why disabled needs no new grey token.
  rowDisabled: {
    opacity: 0.4,
  },
  subtitle: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
  // Same shape as `titleEditorial` above, but reaching for `editorialMeta`
  // (Aleo Light) rather than `cardTitle` (Aleo Bold) — a subtitle is not a
  // heading. Same/lineHeight as `meta` (`editorialMeta` is sized to match),
  // so only the family moves.
  subtitleEditorial: {
    fontFamily: type.editorialMeta.fontFamily,
    fontWeight: undefined,
  },
  valueText: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
});
