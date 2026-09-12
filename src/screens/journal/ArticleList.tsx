// src/screens/journal/ArticleList.tsx
// One article row, shared by JournalScreen (a journal with no volumes — its
// articles sit at the root) and JournalIssueScreen (an issue's own article
// list). Extracted rather than duplicated because both resolve access and
// render the badge/Read affordance identically — this is the one place that
// logic lives.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AccessTierBadge } from '@components/AccessTierBadge';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { formatPublishedDate } from '@model/formatPublishedDate';
import type { Hold, Loan, Publication, Session } from '@model/types';
import { color, elevation, radius, space, type as typeScale } from '@theme/tokens';

export function ArticleList({
  articles,
  onPress,
  indent = false,
  institutionId,
  session,
  loans,
  holds,
}: {
  articles: Publication[];
  onPress: (id: string) => void;
  indent?: boolean;
  institutionId: string;
  session: Session | null;
  loans: Loan[];
  holds: Hold[];
}) {
  return (
    <View style={[styles.articleList, indent && styles.articleListIndent]}>
      {articles.map((article) => {
        const loan = loans.find((l) => l.itemId === article.id);
        const hold = holds.find((h) => h.itemId === article.id);
        const access = resolveAccess({ item: article, institutionId, session, loan, hold });
        const badge = isNotEntitled(access) ? undefined : (
          <AccessTierBadge tier={access.tier} size="sm" />
        );
        // Authors and date share one byline instead of two stacked lines —
        // fewer lines per card is what keeps a list built for scanning many
        // articles from feeling tall, and the two facts read naturally
        // together ("Author A, Author B · 15 March 2021").
        const byline = [
          article.authors.length > 0 ? article.authors.join(', ') : undefined,
          article.published !== undefined ? formatPublishedDate(article.published) : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(' · ');

        return (
          <Pressable
            key={article.id}
            style={({ pressed }) => [styles.articleCard, pressed && styles.articleCardPressed]}
            onPress={() => onPress(article.id)}
            accessibilityRole="button"
            accessibilityLabel={article.title}
          >
            <Text style={styles.articleTitle} numberOfLines={3}>
              {article.title}
            </Text>
            {byline.length > 0 && (
              <Text style={styles.articleMeta} numberOfLines={1}>
                {byline}
              </Text>
            )}
            <View style={styles.articleFooter}>
              {badge !== undefined ? (
                <View style={styles.articleBadge}>{badge}</View>
              ) : (
                <View />
              )}
              <View style={styles.readAffordance} accessibilityElementsHidden>
                <Text style={styles.readAffordanceLabel}>Read</Text>
                <Ionicons name="chevron-forward" size={14} color={color.primary} />
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Cards with a real gap between them, not hairline-divided rows — a plain
  // divided list is what read as "basic" here; a bordered card per article
  // (same border/radius/shadow language ContentCard and the volume/browse
  // cards elsewhere in this flow already use) reads as a designed list
  // instead of a bare stack of text.
  articleList: {
    gap: space.sm,
  },
  articleListIndent: {
    paddingLeft: space.md,
  },
  articleCard: {
    padding: space.md,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.white,
    gap: space.xs,
    ...elevation.card.ios,
    ...elevation.card.android,
  },
  // A visible press state matters more here than on a filled button — the
  // whole card is the tap target, so it needs its own feedback rather than
  // relying on a small "Read" label to carry it.
  articleCardPressed: {
    backgroundColor: color.surface,
  },
  articleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
  articleBadge: {
    alignSelf: 'flex-start',
  },
  articleTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: 16,
    lineHeight: 21,
    color: color.textPrimary,
  },
  articleMeta: {
    ...typeScale.cardMeta,
    color: color.textSecondary,
  },
  // A lighter affordance than a filled pill — this list is built for
  // scanning many rows, and a solid button per row read as heavier than the
  // whole-row tap it sits beside (the row itself is already the Pressable).
  readAffordance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  readAffordanceLabel: {
    ...typeScale.smallLabel,
    color: color.primary,
    fontWeight: '700',
  },
});
