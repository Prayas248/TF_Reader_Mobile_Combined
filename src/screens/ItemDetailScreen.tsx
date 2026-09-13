// Screen 05 (book) and Screen 04 (article) — one screen, two presentations,
// both built on the shared `ItemDetail` model. Reused by both CatalogueStack
// and SearchStack, which is why the route type below stays the minimal shape
// both stacks agree on rather than either stack's own NativeStackScreenProps.
//
// WORK TYPE IS ROUTE-SUPPLIED, NOT DERIVED FROM THE FETCH. Nothing in the
// feed says whether a title is a book or an article: wokay's published
// `@type` enum only confirms Book and Audiobook, so `Publication.workType` is
// never `'article'`. What tells this screen an item is an article is CONTEXT
// — the caller already knows, because it just came from the journal
// drill-down (JournalIssueScreen/JournalScreen navigate here with
// `workType: 'article'` in the route params, see navigation/types.ts's
// `ArticleContext`). `route.params.workType ?? publication.workType ??
// BOOK_WORK_TYPE` is the precedence: an explicit route param wins, then
// whatever the normalizer read off `@type`, then the book fallback. The
// moment wokay confirms a journal/article `@type` value (Q-1b), only
// `WOKAY_TYPE_MAP` in opds/normalize.ts needs extending — this screen's own
// fallback chain does not change.
//
// THE ARTICLE PRESENTATION IS NOW REACHABLE — it used to be dead code (kept
// and tested directly, same shape as `resolveAccess`'s "no acquisition link"
// branch) because nothing ever set `workType: 'article'` before the journal
// drill-down existed. `renderArticleContent` below stays exported so a test
// can still hand it a hand-built `ItemDetail` directly — see
// ItemDetailScreen.test.tsx.
//
// ACCESS IS RESOLVED REACTIVELY, NOT ONCE AT FETCH TIME. The publication is stored
// separately and detail is recomputed whenever loans/holds change (after a borrow,
// return, hold, or accept). This is what makes the action bar update immediately
// after a tap without re-fetching from wokay — the catalogue data is stable, only
// the licence state changes.
//
// THREE STATES, KEPT VISIBLY DISTINCT, plus an offline overlay that is
// independent of them. Same shape as InstitutionDetailScreen: a skeleton while
// the fetch is in flight, ErrorState on rejection, the content once resolved. No
// ActivityIndicator — skeletons replace spinners.
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import type { BookId, ContentFormat } from '@/shared/contracts';
import { useCurrentSession, useIsSignedIn } from '@access/currentSession';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { ActionBar } from '@components/ActionBar';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { DescriptionSection } from '@components/DescriptionSection';
import { ErrorState } from '@components/ErrorState';
import { OfflineBanner } from '@components/OfflineBanner';
import { Skeleton } from '@components/Skeleton';
import { SectionHeader } from '@components/SectionHeader';
import { getCatalogueSource } from '@config/catalogue';
import { getLicenceSource } from '@config/licence';
import { borrowOrPlaceHold, queuePositionLabel } from '@/licence/queueRequest';
import { openBook } from '@/features/download/openBook';
import { useDownloadProgress } from '@/features/download/useDownloadProgress';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import { buildItemDetail, type ItemDetail } from '@model/detail';
import { type CatalogueError, isCatalogueFailure } from '@model/errors';
import { CATALOGUE_ERROR_COPY, catalogueErrorVariant, WIRE_ERROR_COPY } from '@model/errorCopy';
import { isLicenceFailure, LicenceError } from '@/licence/LicenceSource';
import { ERROR_CODES } from '@model/types';
import type { ActionId, ErrorCode, Publication, WorkType } from '@model/types';
import type { ArticleContext } from '../navigation/types';
import { formatPublishedDate } from '@model/formatPublishedDate';
import { useDownloadStore } from '@store/downloadStore';
import { useInstitutionStore } from '@store/institutionStore';
import { useLibraryStore } from '@store/libraryStore';
import { useRecentlyViewedStore } from '@store/recentlyViewedStore';
import { color, elevation, radius, space, type as typeScale } from '@theme/tokens';

interface ItemDetailRouteProps {
  // workType/articleContext are present only when this screen is reached from
  // the journal drill-down — see this file's header and navigation/types.ts's
  // `ArticleContext`. Absent for an ordinary book/audiobook push.
  route: { params: { itemId: string; workType?: WorkType; articleContext?: ArticleContext } };
  // Hand-typed rather than one stack's generated props, same reason as
  // `route` above — this screen is shared by three stacks, and `navigate` is
  // typed for exactly the real calls it makes: opening the access gate when
  // `resolveAccess` resolves to `requires_signin`, and opening the reader or
  // the audio player once `openBook()` resolves. `getParent` is the other
  // one — hiding the shared four-tab bar for this one detail screen, see the
  // effect that calls it below and AppTabBar's own header comment in
  // RootNavigator.tsx for why this is the reliable trigger (a plain nested
  // push is not).
  //
  // NO TITLE IS SET HERE, AND NONE SHOULD BE. `AppHeader` (RootNavigator.tsx,
  // `itemDetailHeaderTitle`) shows the name of whichever screen "back"
  // returns to for this route — a shelf, a search results list, an
  // institution page — rather than a fixed label; `options.title`
  // ('Item Details') registered there is only the fallback for no previous
  // screen. An earlier version of this screen called
  // `navigation.setOptions({ title: ... })` to relabel an article as
  // 'Article Details' — which left a real gap the other direction, since
  // nothing ever relabelled an AUDIO-format item and it stayed 'Book
  // Details' regardless. Reader, publisher and journal content share one
  // shelf, one detail page and one route; narrowing the title per work type
  // is still the thing to avoid, and the fix now is orthogonal to work type
  // entirely — the title tracks navigation history, not content.
  navigation: {
    navigate(screen: 'AccessGate', params: { itemId: string; title: string; authors: string }): void;
    navigate(screen: 'Reader', params: { bookId: BookId; format: ContentFormat }): void;
    // AUDIO's own destination — see `handleAction`'s 'read'/'play' branch for
    // why this is a second overload rather than folding into 'Reader' above.
    navigate(screen: 'AudioPlayer', params: { bookId: BookId; title: string }): void;
    getParent: () =>
      | { setOptions: (options: { tabBarStyle?: { display: 'none' } }) => void }
      | undefined;
  };
}

// Explicit and typed, so this line breaks to a compile error rather than a typo
// if 'book' is ever removed from the work-type vocabulary.
export const BOOK_WORK_TYPE: WorkType = 'book';

// Screen 04's work type. Not yet passed to `buildItemDetail` anywhere in this
// file — see the header comment. Declared and exported beside `BOOK_WORK_TYPE`
// so a test can build an article `ItemDetail` from the same constant this file
// would use, rather than a second hand-typed 'article' string that could drift.
export const ARTICLE_WORK_TYPE: WorkType = 'article';

// A real book-cover ratio (2:3), sized to be the prominent element a detail
// page's jacket should be — bigger than the row/carousel thumbnail this same
// `coverUrl` renders as elsewhere (192dp, within the 180–210dp a phone-sized
// detail page's jacket should read as), but well short of filling the
// screen (288dp tall, on a device whose own height is roughly triple that).
const COVER_WIDTH = space.xl * 6;
const COVER_HEIGHT = space.xl * 9;

const GENERIC_MESSAGE = "We couldn't load this title.";
const LICENCE_GENERIC_MESSAGE = "That action couldn't be completed. Please try again.";


// Screen 05's presentation. Exported for the same reason `renderArticleContent`
// below is — a test can render it directly from a hand-built `ItemDetail`
// without going through the fetch — not because anything outside this file is
// meant to import it.
//
// THE COVER IS CENTRED; NOTHING ELSE IS. The mockup centres the jacket in the
// column and ranges every line beneath it off the left margin — title, edition,
// author, copyright, the price pair, the badge and the metadata list all share
// one edge. The whole column used to be centred, which gave the metadata rows a
// ragged left edge and no relationship to the title above them. Same left-ranged
// rule the article layout follows and the Monday branding pass is applying to
// the empty and error screens.
//
// THE ACTION BAR IS PINNED, NOT SCROLLED — same as the article layout, and for
// the same reason: the mockup fixes Read and Download to the bottom of the
// viewport, and this screen is a full jacket plus a description, so a bar at the
// end of the scroll is a bar the reader has to work for.
export function renderBookContent(
  detail: ItemDetail,
  onAction: (action: ActionId) => void,
  // The action waiting on flambeau, if any. Optional so the existing two-argument
  // callers keep working; `undefined` is the same "nothing in flight" ActionBar
  // already defaults to.
  pending?: ActionId,
  // D13: plain-English message from a failed licence call, shown above the bar.
  licenceMessage?: string,
  // Whether the cover Image itself reported a load failure — lives in
  // ItemDetailScreen's own state (hooks cannot live in a plain function
  // called mid-render, only in the component actually rendering), reset there
  // whenever a new publication arrives.
  coverFailed = false,
  onCoverError?: () => void,
): ReactElement {
  const showCoverPlaceholder = detail.coverUrl === undefined || coverFailed;

  // The one presentational remap this screen does: `resolveAccess` only ever
  // returns `read` (see `ACTION_IDS`'s own note on why the swap does not
  // belong there), so an AUDIO item's bar is relabelled to `play` here,
  // before it reaches `ActionBar`. `pending` needs no equivalent remap — it
  // is only ever set from whatever `ActionBar` handed back to `onAction`,
  // which already reads this same remapped array. `handleAction` treats
  // `read` and `play` identically once pressed.
  const actions: ActionId[] =
    detail.format === 'AUDIO'
      ? detail.access.actions.map((action) => (action === 'read' ? 'play' : action))
      : detail.access.actions;

  return (
    <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Centred and always renders a well — a missing cover and a failed
            fetch used to leave nothing at all where the jacket goes, which
            reads as a layout bug rather than "this title has no cover on
            file". The icon marks it as a deliberate stand-in, same device
            ContentCard's own placeholder uses for exactly this pair of
            cases. */}
        <View style={styles.coverWrap}>
          {showCoverPlaceholder ? (
            <View testID="item-detail-cover-placeholder" style={[styles.cover, styles.coverPlaceholder]}>
              <MaterialCommunityIcons name="book-outline" size={COVER_WIDTH / 2} color={color.textSecondary} />
            </View>
          ) : (
            <Image
              testID="item-detail-cover"
              // See ContentCard.tsx's note — the backend re-signs this URL's
              // querystring on every fetch, so the cache key must ignore it.
              source={{ uri: detail.coverUrl, cacheKey: detail.coverUrl?.split('?')[0] }}
              style={styles.cover}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={200}
              accessibilityLabel={`${detail.title} cover`}
              onError={onCoverError}
            />
          )}
        </View>

        {/* Title/subtitle on the left, Share as a small icon button on the
            right — same placement JournalScreen uses for its own Share
            button, so a book/audiobook and a journal share one visual
            language for this action rather than each inventing its own. */}
        <View style={styles.titleRow}>
          <View style={styles.titleColumn}>
            <Text style={styles.title}>{detail.title}</Text>
            {detail.subtitle !== undefined && <Text style={styles.subtitle}>{detail.subtitle}</Text>}
          </View>
          <Pressable
            style={styles.shareIconButton}
            onPress={() => void Share.share({ message: detail.title })}
            accessibilityRole="button"
            accessibilityLabel="Share"
          >
            <Ionicons name="share-outline" size={18} color={color.primary} />
          </Pressable>
        </View>

        {/* "By" carried in the primary text colour with the names themselves in
          the link colour, which is how the mockup sets this line. Nested rather
          than two siblings so the names wrap under the "By" as one sentence
          instead of forming a second column. Nothing navigates — there is no
          author route — so it takes the mockup's colour and not its behaviour,
          the same note as the article layout's author line. */}
        {detail.authors.length > 0 && (
          <Text style={styles.byLine}>
            By <Text style={styles.byLineNames}>{detail.authors.join(', ')}</Text>
          </Text>
        )}

        {/* Format and access tier share one row — both are short, compact
            facts about the same title ("EPUB" / "Elite"), not two separate
            sections. D8 — `not_entitled` renders no badge at all; `tier` is
            required on AccessResult, so that state carries an OPEN_ACCESS
            filler that would mislabel a title the reader cannot open as free
            to read. ActionBar already renders null on the empty action set,
            so the buttons need no gate of their own. Renders nothing at all
            (not even the row) when neither is present, rather than an empty
            band of padding. */}
        {(detail.format !== undefined || !isNotEntitled(detail.access)) && (
          <View style={styles.badgeRow}>
            {detail.format !== undefined && <FormatStrip format={detail.format} />}
            {!isNotEntitled(detail.access) && <AccessTierBadge tier={detail.access.tier} />}
          </View>
        )}

        {/* D12 — the `queued` half: "queued shows a position and nothing
            tappable". `resolveAccess` returns no actions in that state, so
            ActionBar draws nothing and this line is the entire UI for it —
            without it a waiting reader sees a detail screen with no answer. */}
        <QueuePositionLine access={detail.access} />

        {/* Publisher, published date, ISBN and page count are each shown only
          when the feed actually supplied them — "render whatever fields are
          present; leave gaps blank rather than blocking" applies here exactly
          as it does in `renderArticleContent` below. The mockup fences this
          list off with a rule above it and gives each row its own glyph, which
          is what turns four bare strings into a spec block.

          PUBLISHER AND DATE SHARE A LINE when both arrived — "Published <date>
          · <publisher>", a human date rather than the feed's raw ISO string.
          Either one alone still gets its own row, because half that sentence
          is not a sentence. */}
        <View style={styles.metaBlock}>
          <View style={styles.rule} />

          {detail.isbn !== undefined && (
            <MetaRow icon="book-open-variant" text={`ISBN ${detail.isbn}`} />
          )}

          {detail.numberOfPages !== undefined && (
            <MetaRow icon="file-document-outline" text={`${detail.numberOfPages} pages`} />
          )}

          {detail.published !== undefined && detail.publisher !== undefined && (
            <MetaRow
              icon="calendar-blank-outline"
              text={`Published ${formatPublishedDate(detail.published)} · ${detail.publisher}`}
            />
          )}
          {detail.published !== undefined && detail.publisher === undefined && (
            <MetaRow
              icon="calendar-blank-outline"
              text={`Published ${formatPublishedDate(detail.published)}`}
            />
          )}
          {detail.published === undefined && detail.publisher !== undefined && (
            <MetaRow icon="domain" text={`Publisher ${detail.publisher}`} />
          )}
        </View>

        {/* ALWAYS RENDERED — a structural section, not conditional on
            `detail.description` being present: show whatever the feed
            currently sends verbatim, and fall back to an honest "not
            available yet" only when the field is genuinely absent. This
            screen used to filter out the catalogue source's own dev-fixture
            placeholder text ("Real EPUB/PDF/audio fixture… ingested from a
            real file", confirmed present on every current title, "Politics
            of Coalition in Korea" included) — reversed on explicit
            instruction: show the actual field value, not this screen's own
            judgement about which values count as real. */}
        {/* "About this title", not "About this book" — this section renders
            for every AUDIO-format audiobook too (workType 'book' spans
            both), and an audiobook is not a book. */}
        <DescriptionSection title="About this title" description={detail.description} />

        {/* TABLE OF CONTENTS IS OMITTED ENTIRELY. No endpoint, no model
            field — there is nothing to leave a gap for, and a lone heading
            with nothing beneath it read as the page announcing its own
            unfinished-ness rather than as a clean, focused screen. */}
      </ScrollView>

      {/* Outside the ScrollView — see the header comment. ActionBar pads itself
          and draws its own top border, so it needs no wrapper of its own here. */}
      {licenceMessage !== undefined && (
        <Text style={styles.licenceError} accessibilityRole="alert" testID="licence-error">
          {licenceMessage}
        </Text>
      )}
      <ActionBar actions={actions} onAction={onAction} pending={pending} />
    </>
  );
}

// One metadata row: a muted glyph and the line it belongs to. The icon is
// decorative — the text beside it already says everything, so it is never the
// only thing a screen reader is given, and the row keeps `Text`'s own default
// role rather than claiming to be an image.
function MetaRow({
  icon,
  text,
}: {
  icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
  text: string;
}): ReactElement {
  return (
    <View style={styles.metaRowLine}>
      <MaterialCommunityIcons name={icon} size={typeScale.meta.size} color={color.textSecondary} />
      <Text style={[styles.metaRow, styles.metaRowText]}>{text}</Text>
    </View>
  );
}

// D12's `queued` state on the detail screen. A status line, not a control.
//
// LOCAL TO THIS SCREEN, because this is the ONLY surface the queue appears on.
// Confirmed team decision, 26 Aug: D12 is item detail only, so there is no card
// row wanting the same block and nothing to share it with. A shared component
// for one caller is the speculative one CONVENTIONS §10 rules out.
//
// ABSENT IN EVERY OTHER STATE, including `offered`: the position is a fact about
// waiting, and a reader who has been offered a copy is no longer waiting.
function QueuePositionLine({ access }: { access: ItemDetail['access'] }): ReactElement | null {
  const label = queuePositionLabel(access);
  if (label === undefined) return null;

  return (
    <Text testID="queue-position" style={styles.queuePosition} accessibilityRole="text">
      {label}
    </Text>
  );
}

// The one confirmed format, shown as a plain strip rather than a control —
// index.html: "the contract confirms one format per title, so there is
// nothing to select between... it becomes a single-format display strip
// rather than a control."
//
// NOT `Tabs` OR `FilterChip`. Both exist to switch or toggle between several
// values; there is exactly one value here, so a control built to manage many
// would be answering a question this screen does not have. No `Pressable`,
// no `onPress`, no active/inactive pair — `AccessTierBadge` is the same shape
// one line below every call site: a resolved value that is looked at.
//
// NOT MUTED. This is real, confirmed data — the contract states it plainly —
// so it reads at full opacity in the primary text colour.
function FormatStrip({ format }: { format: ContentFormat }): ReactElement {
  return (
    <View testID="format-strip" style={styles.formatStrip} accessibilityRole="text">
      <Text style={styles.formatStripLabel}>{format}</Text>
    </View>
  );
}

// Subjects, on both screen 02 (journal) and screen 04 (article): real,
// confirmed data (`Publication.subjects`/the journal work feed's own
// `subjects`), shown as a static, non-interactive pill — same "real data,
// not a control" shape `FormatStrip` above already uses for the format
// badge. NOT the interactive `SubjectChip` component: that models
// selection/filtering behind a required `onPress`, and there is no
// subject-browse destination in this app to wire it to — a disabled
// Pressable here would promise an interaction that does not exist, the same
// trap this file's former `UnavailableTag` comment warned against.
function SubjectsRow({ subjects }: { subjects: string[] }): ReactElement | null {
  if (subjects.length === 0) return null;
  return (
    <View style={styles.subjectsRow}>
      {subjects.map((subject) => (
        <View key={subject} style={styles.subjectChip}>
          <Text style={styles.subjectChipLabel} numberOfLines={1}>
            {subject}
          </Text>
        </View>
      ))}
    </View>
  );
}

// Screen 04's presentation. Deliberately smaller than the book's field list —
// publisher, ISBN, cover and subtitle are still not read here even though
// `ItemDetail` carries them: they are book fields the article mockup never
// asked for. `published`/`numberOfPages` ARE read now, inside the "Published
// in" card below (moved out of the plain under-title line they used to be,
// on explicit instruction, once the card existed and repeating the same fact
// twice on one screen became the problem worth fixing).
//
// NO PAGE RANGE. `Publication` has no field for it and neither backend
// contract mentions one, so there is nothing to read. Left absent rather than
// invented. (`numberOfPages` is a different, real field — a whole-article
// page count, not a range within the issue — and is shown when present.)
//
// NO CONTENT-TYPE EYEBROW ("Research Article"/"Review Article"), NO
// "Download citation" ROW, NO TAB STRIP. All three used to render as visible-
// but-muted placeholders for an older, separate mockup spec (see git history
// for that version) — removed on explicit instruction rather than kept: none
// of the three has real data behind it (wokay's `@type` enum has no
// article/review distinction; there is no citation endpoint; there is no
// second, more-specific screen behind any of Full Article/Figures &
// data/Citations/Metrics/PDF), and showing a placeholder for something that
// will never resolve is worse than not showing it at all. If wokay ever
// confirms a real content-type field, it renders here as ordinary text, not
// as a tag that returns.
//
// LEFT-ALIGNED, NOT CENTRED. Screen 04 is a reading surface: a title that
// runs to three lines, an author line, then metadata, the badge, the
// abstract and Subjects, all ranged left off a single margin. Screen 05
// keeps its centred column — a cover-led layout has a real axis to centre
// on; this one does not.
//
// THE ACTION BAR IS PINNED, NOT SCROLLED. An abstract is long enough that a
// bar at the end of the scroll is a bar the reader never reaches. It sits
// outside the ScrollView, which is why this returns a fragment rather than a
// single ScrollView the way `renderBookContent` still does.
export function renderArticleContent(
  detail: ItemDetail,
  onAction: (action: ActionId) => void,
  /** See renderBookContent. */
  pending?: ActionId,
  /** See renderBookContent. */
  licenceMessage?: string,
  // Journal/volume/issue names, present only when this article was opened
  // from the journal drill-down (JournalIssueScreen/JournalScreen pass it as
  // a route param — see navigation/types.ts's ArticleContext). A Publication
  // carries no parent-journal reference of its own, so there is nothing to
  // read here when the article was opened any other way (e.g. Search).
  articleContext?: { journalTitle: string; volumeTitle?: string; issueTitle?: string },
): ReactElement {
  const issueLine =
    articleContext !== undefined
      ? [articleContext.volumeTitle, articleContext.issueTitle].filter(
          (part): part is string => part !== undefined,
        )
      : [];

  return (
    <>
      <ScrollView style={styles.articleScroll} contentContainerStyle={styles.articleContent}>
        {/* Title block — the lines the mockup groups tightly together, on xs
            gaps, so they read as one unit against the md gaps separating the
            sections below. NO journal/volume/issue eyebrow here any more —
            that information lives in ONE place now, the "Published in" card
            below, rather than twice on the same page. */}
        <View style={styles.articleHeader}>
          <Text style={styles.articleTitle}>{detail.title}</Text>

          {detail.authors.length > 0 && (
            <Text style={styles.articleAuthors}>{detail.authors.join(', ')}</Text>
          )}
        </View>

        {/* D8 — `not_entitled` renders nothing at all, badge included. `tier`
            is required on AccessResult, so that state carries an OPEN_ACCESS
            filler; drawing it would label a title the reader cannot open as
            free to read. ActionBar already renders null on the empty action
            set, so the buttons need no gate. */}
        {!isNotEntitled(detail.access) && <AccessTierBadge tier={detail.access.tier} />}

        {/* D12 — the `queued` half: "queued shows a position and nothing
            tappable". `resolveAccess` returns no actions in that state, so
            ActionBar draws nothing and this line is the entire UI for it —
            without it a waiting reader sees a detail screen with no answer. */}
        <QueuePositionLine access={detail.access} />

        {/* ONE card, not a repeated eyebrow-plus-card: journal/volume/issue
            (real data on `articleContext`, present only when this article was
            opened from the journal drill-down — a Publication carries no
            parent-journal reference of its own, so there is nothing to read
            here when opened any other way, e.g. a Search result), PLUS
            whatever article-specific facts the publication itself supplies
            (`published`, `numberOfPages`) — each shown only when actually
            present, never a placeholder. This is also where an article with a
            short or missing abstract gets real, useful content instead of a
            blank scroll area. Non-interactive, same reasoning as
            SubjectsRow: there is no "open this issue from here" route
            registered in every stack this screen is shared across (Search,
            Library), only Catalogue's. */}
        {(articleContext !== undefined || detail.published !== undefined || detail.numberOfPages !== undefined) && (
          <View style={styles.publishedInCard}>
            <MaterialCommunityIcons name="book-open-page-variant-outline" size={22} color={color.primary} />
            <View style={styles.publishedInText}>
              {articleContext !== undefined && (
                <>
                  <Text style={styles.publishedInLabel}>Published in</Text>
                  <Text style={styles.publishedInJournal}>{articleContext.journalTitle}</Text>
                  {issueLine.length > 0 && (
                    <Text style={styles.publishedInIssue}>{issueLine.join(' · ')}</Text>
                  )}
                </>
              )}

              {(detail.published !== undefined || detail.numberOfPages !== undefined) && (
                <View
                  style={
                    articleContext !== undefined
                      ? styles.publishedInDivider
                      : styles.publishedInNoDivider
                  }
                >
                  {detail.published !== undefined && (
                    <>
                      <Text style={styles.publishedInLabel}>Published online</Text>
                      <Text style={styles.publishedInIssue}>{formatPublishedDate(detail.published)}</Text>
                    </>
                  )}
                  {detail.numberOfPages !== undefined && (
                    <Text style={styles.publishedInIssue}>{detail.numberOfPages} pages</Text>
                  )}
                </View>
              )}
            </View>
          </View>
        )}

        {/* The abstract is `ItemDetail.description` under the label this screen
            uses for it. Absent entirely — no heading, no empty block — when the
            feed did not supply one, same "leave gaps blank" rule as everywhere
            else on this screen. */}
        {detail.description !== undefined && (
          <View style={styles.abstractBlock}>
            <SectionHeader title="Abstract" />
            <Text style={styles.abstractText}>{detail.description}</Text>
          </View>
        )}

        {/* Real data (Publication.subjects) — hidden entirely when empty, not
            a section with nothing under it. */}
        {detail.subjects.length > 0 && (
          <View style={styles.abstractBlock}>
            <SectionHeader title="Subjects" />
            <SubjectsRow subjects={detail.subjects} />
          </View>
        )}
      </ScrollView>

      {/* Outside the ScrollView — see the header comment. ActionBar pads itself
          and draws its own top border, so no wrapper is needed here; the
          `actionBarWrapper` stretch fix exists only for the book layout, whose
          centring column would otherwise shrink it. */}
      {licenceMessage !== undefined && (
        <Text style={styles.licenceError} accessibilityRole="alert" testID="licence-error">
          {licenceMessage}
        </Text>
      )}
      <ActionBar actions={detail.access.actions} onAction={onAction} pending={pending} />
    </>
  );
}

export default function ItemDetailScreen({ route, navigation }: ItemDetailRouteProps) {
  const { itemId, workType: routeWorkType, articleContext } = route.params;
  const downloadProgress = useDownloadProgress();

  const selectedInstitution = useInstitutionStore((s) => s.selectedInstitution);

  // Null unless the reader has actually signed in — selecting an institution
  // alone is no longer enough (see currentSession.ts's note on why this
  // replaced handToggledSession).
  const session = useCurrentSession();

  // The signed-in session's own institution is authoritative once there is
  // one — it's what wokay will actually recognise this reader's token
  // against. `selectedInstitution` (the picker, browsable before sign-in) is
  // only a fallback for the ahead-of-sign-in case, so a reader who picked one
  // institution and then signed in as a member of another doesn't keep
  // fetching under the stale picked one and getting NOT_FOUND back.
  //
  // NULL IS A REAL STATE HERE, not a missing value: this screen is reachable
  // from the public catalogue, where the reader has chosen no institution. It
  // picks the public endpoint in that case, and resolveAccess already takes
  // `institutionId: string | null`, so the null travels all the way through
  // rather than being papered over with a default id.
  const institutionId = session?.institutionId ?? selectedInstitution?.id ?? null;

  // getPublication now requires this (wokay's contract: appToken), but this
  // screen mounts off the selected institution alone, ahead of sign-in — same
  // reasoning as CatalogueScreen.tsx's isSignedIn: without it in fetchItem's
  // deps, a sign-in completing while this screen stays mounted would never
  // re-run the effect below.
  const isSignedIn = useIsSignedIn();

  const isOnline = useNetworkStatus();

  // Holdings from the session cache. The cache starts empty and is populated by
  // refresh() — resolveAccess treats undefined loan/hold as "nothing held", so the
  // action bar is correct on first render and updates once the cache arrives.
  const loans = useLibraryStore((s) => s.loans);
  const holds = useLibraryStore((s) => s.holds);
  const refresh = useLibraryStore((s) => s.refresh);
  const loan = loans.find((l) => l.itemId === itemId);
  const hold = holds.find((h) => h.itemId === itemId);

  // Publication stored separately so that access can be re-resolved whenever
  // loan/hold change — without re-fetching from wokay.
  const [publication, setPublication] = useState<Publication | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The licence call currently waiting on flambeau — handed to ActionBar so the
  // tapped button goes busy. `undefined` is "nothing in flight".
  const [pendingAction, setPendingAction] = useState<ActionId | undefined>(undefined);
  const [errorCode, setErrorCode] = useState<CatalogueError | undefined>(undefined);
  // Plain-English message from a failed licence call. Cleared at the start of the
  // next tap so the reader knows whether the new attempt also failed.
  const [licenceMessage, setLicenceMessage] = useState<string | undefined>(undefined);
  // Whether the cover Image reported a load failure — lives here rather than
  // inside `renderBookContent` because that is a plain function called
  // during this component's own render, not a component of its own; hooks
  // follow the fiber that is actually rendering, so they can only live here.
  // Reset on every successful fetch, same as `failed`/`errorCode` above, so a
  // stale failure from a previous item does not survive a fresh one.
  const [coverFailed, setCoverFailed] = useState(false);

  // Recomputed whenever the publication or the reader's holdings change. Pure and
  // fast — no call is made, resolveAccess is synchronous.
  const detail: ItemDetail | null = useMemo(() => {
    if (publication === null) return null;
    const access = resolveAccess({
      item: publication,
      institutionId,
      session,
      loan,
      hold,
    });
    // See this file's header: an explicit route param (set by the journal
    // drill-down) wins, then whatever the normalizer read off @type, then the
    // book fallback.
    return buildItemDetail({
      publication,
      workType: routeWorkType ?? publication.workType ?? BOOK_WORK_TYPE,
      access,
    });
  }, [publication, institutionId, session, loan, hold, routeWorkType]);

  // Hides the shared four-tab bar for exactly this screen — a detail page,
  // not one of Catalogue/Search/Library/Profile. `getParent()` reaches the
  // Tab.Navigator; `setOptions` on it sets `tabBarStyle` for the CURRENTLY
  // FOCUSED TAB SCREEN only (Catalogue or Search, whichever stack pushed
  // this), which is exactly the per-screen scope wanted — the other three
  // tabs' own bar is untouched. Restored on unmount so navigating back
  // reveals it again; see AppTabBar's own header comment in
  // RootNavigator.tsx for why this, and not a plain nested push, is what the
  // custom tab bar actually re-renders on.
  useEffect(() => {
    navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => navigation.getParent()?.setOptions({ tabBarStyle: undefined });
  }, [navigation]);

  // No synchronous setState in here — only inside the async continuations. Same
  // note as InstitutionDetailScreen: retry is the one path that resets
  // loading/failure, and it runs from a press handler, not an effect.
  const fetchItem = useCallback(() => {
    const source = getCatalogueSource();
    // No institution means the reader arrived from the public catalogue, so the
    // public route is the only one that can honestly answer for them.
    const request =
      institutionId === null
        ? source.getPublicPublication(itemId)
        : source.getPublication(institutionId, itemId);

    request
      .then((pub) => {
        setPublication(pub);
        // Clears a failure left over from an earlier attempt on this same
        // item — e.g. the reader signing in after a signed-out 401 — so a
        // stale error state does not survive a fetch that just succeeded.
        setFailed(false);
        setErrorCode(undefined);
        setCoverFailed(false);
        // Search's own idle-state "Recently viewed" row (screen 09) — recorded
        // here, not in Search, because this is the one place in the app that
        // actually resolves a full `Publication` for an item id. See
        // recentlyViewedStore.ts's own note on why this stores a snapshot.
        useRecentlyViewedStore.getState().recordView(pub);
      })
      .catch((err: unknown) => {
        setErrorCode(isCatalogueFailure(err) ? err.code : undefined);
        setFailed(true);
      })
      .finally(() => setLoading(false));
    // isSignedIn is intentionally listed even though the body never reads it
    // — see the isSignedIn comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institutionId, itemId, isSignedIn]);

  useEffect(() => {
    fetchItem();
    // Fetch the reader's holdings once per mount so the action bar reflects live
    // state rather than the empty-cache default. Runs in parallel with fetchItem —
    // neither blocks on the other.
    void refresh();
  }, [fetchItem, refresh]);

  useEffect(() => {
    if (downloadProgress.status === 'completed') {
      // Format-agnostic wording — this fires for a journal article and an
      // audiobook too, neither of which the reader "reads" in the literal
      // sense "for offline reading" implies.
      Alert.alert('Download complete', 'Saved for offline access.');
      // `useDownloadProgress`/`downloadManager` persist the bytes to SQLite
      // (`contentStore`/`downloadTable`), but `LibraryScreen`'s Downloads tab
      // still reads the older, unrelated `downloadStore` (see that file's own
      // "THE SEAM IS THIS STORE, AND IT IS MEANT TO BE REPLACED" header) — a
      // merge dropped this screen's old `markDownloaded` call without adding
      // a replacement, so a real, successful download never showed up there.
      // Keeping this write-through here (rather than inside
      // `useDownloadProgress`/`downloadManager`, which are Download's own
      // files) is the fix "the download layer keep this list in step" that
      // store's header names, made from the one place that already knows a
      // download for THIS itemId just completed.
      useDownloadStore.getState().markDownloaded({
        itemId,
        downloadedAt: Date.now(),
        sizeBytes: downloadProgress.bytesReceived,
      });
    } else if (downloadProgress.status === 'error') {
      Alert.alert('Download failed', downloadProgress.errorMessage ?? 'Something went wrong.');
    }
  }, [downloadProgress.status, downloadProgress.errorMessage, downloadProgress.bytesReceived, itemId]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    fetchItem();
  }, [fetchItem]);

  // ONE LICENCE CALL IN FLIGHT, AND THE BAR SAYS SO. Every branch below used to
  // be fire-and-forget: the button stayed idle, so Read or Grant access could be
  // tapped four times while the first borrow was still open and each tap made
  // another call. `pendingAction` is what ActionBar's own `pending` prop was
  // built for — it renders that one button `loading`, and ActionButton makes a
  // loading button `disabled`, so the tapped control stops accepting presses on
  // its own. The state check below closes the same door for the OTHER buttons in
  // the bar, which stay visually idle.
  //
  // NO REF GUARD, DELIBERATELY. A synchronous `inFlight` ref would be captured by
  // `handleAction`, which is handed to `renderBookContent` — a function called
  // during render — and `react-hooks/refs` rejects that for a real reason: a ref
  // read during render does not re-render when it changes. The disabled Pressable
  // is the guard the component library already provides, and it is the one the
  // rest of this app relies on (see ActionButton's `inert`).
  const runLicenceCall = useCallback(
    (action: ActionId, call: () => Promise<unknown>) => {
      // Clear any previous message so the reader knows this tap is a fresh attempt.
      setLicenceMessage(undefined);
      setPendingAction(action);

      call()
        // Caught before the refresh so a failed call still invalidates the cache
        // — a borrow that threw may still have created the loan.
        .catch((err: unknown) => {
          if (isLicenceFailure(err) && err.code === LicenceError.REFUSED) {
            const knownCode =
              err.errorCode !== undefined &&
              (ERROR_CODES as readonly string[]).includes(err.errorCode)
                ? (err.errorCode as ErrorCode)
                : undefined;
            setLicenceMessage(
              knownCode !== undefined ? WIRE_ERROR_COPY[knownCode] : LICENCE_GENERIC_MESSAGE,
            );
          }
        })
        .then(() => refresh())
        .catch(() => {})
        .finally(() => setPendingAction(undefined));
    },
    [refresh],
  );

  const handleAction = useCallback(
    (action: ActionId) => {
      // Nothing while a licence call is open. `signIn` is exempt below only
      // because it is navigation, not a call — and it cannot coexist with one
      // anyway, since resolveAccess never returns signIn beside the four.
      if (pendingAction !== undefined) return;

      if (action === 'signIn') {
        if (detail !== null) {
          navigation.navigate('AccessGate', {
            itemId: detail.id,
            title: detail.title,
            authors: detail.authors.join(', '),
          });
        }
        return;
      }

      // The four licence calls. Each mutates server state, so the holdings cache is
      // invalidated immediately after — refresh() re-fetches GET /api/v1/library and
      // the action bar updates to reflect the new loan or hold. All four now run
      // through `runLicenceCall`, which owns the pending state and the guard.
      const source = getLicenceSource();
      if (action === 'download') {
        // Download no longer borrows directly — it hands off to
        // `useDownloadProgress`'s `start()`, which drives `downloadManager.ts`
        // and reports real byte progress; the `Alert`s in the effect above
        // fire on its `completed`/`error` status. Guarded on both a known
        // format and an already-running download, same reason `handleAction`
        // itself guards on `pendingAction`.
        const format = detail?.format;
        if (format === undefined) return;
        if (downloadProgress.status === 'downloading') return;
        downloadProgress.start(itemId as BookId, format);
      } else if (action === 'read' || action === 'play') {
        // `play` is `read` relabelled for an AUDIO item, not a second
        // entitlement (see `ACTION_IDS`'s own note and this file's remap in
        // `renderBookContent`) — both open the same way. `openBook` decrypts
        // and stages the content locally; only once that resolves does this
        // navigate to the real reader/player, so a refused or failed open
        // never lands the reader on a screen with nothing to show.
        if (detail === null) return;
        const { format } = detail;
        if (format === undefined) return;
        setLicenceMessage(undefined);
        setPendingAction(action);
        openBook(itemId as BookId, format)
          .then(() => {
            // AUDIO opens the audio player, not the EPUB/PDF reader — the two
            // are separate screens (AudioPlayerRouteScreen vs
            // ReaderRouteScreen) with unrelated implementations underneath
            // (expo-audio vs the epub.js/pdf.js WebView bridge), and pushing
            // an audiobook into 'Reader' fed it content the WebView bridge
            // cannot parse.
            if (format === 'AUDIO') {
              navigation.navigate('AudioPlayer', { bookId: itemId as BookId, title: detail.title });
            } else {
              navigation.navigate('Reader', { bookId: itemId as BookId, format });
            }
          })
          .catch((err: unknown) => {
            console.error('[read] openBook failed:', err);
            setLicenceMessage(LICENCE_GENERIC_MESSAGE);
          })
          .finally(() => {
            void refresh();
            setPendingAction(undefined);
          });
      } else if (action === 'revokeLicence' && loan?.loanId !== undefined) {
        const loanId = loan.loanId;
        runLicenceCall(action, () => source.returnLoan(loanId));
      } else if (action === 'grantAccess') {
        // Elite path: borrow first, queue only on NO_COPIES_AVAILABLE. The rule
        // lives in `borrowOrPlaceHold` — see src/licence/queueRequest.ts. It is
        // there rather than inline because the refusal rule is easy to get
        // subtly wrong and dangerous when wrong, so it earns its own tests.
        runLicenceCall(action, () => borrowOrPlaceHold(source, itemId));
      } else if (action === 'acceptOffer' && hold?.holdId !== undefined) {
        const holdId = hold.holdId;
        runLicenceCall(action, () => source.acceptOffer(holdId));
      } else if (action === 'rejectOffer' && hold?.holdId !== undefined) {
        const holdId = hold.holdId;
        runLicenceCall(action, () => source.cancelHold(holdId));
      }
    },
    [navigation, detail, itemId, loan, hold, pendingAction, runLicenceCall, downloadProgress, refresh],
  );

  let body: ReactNode;

  if (loading) {
    body = (
      <View style={styles.loading} testID="item-detail-skeleton">
        <Skeleton variant="block" width={COVER_WIDTH} height={COVER_HEIGHT} />
        <Skeleton variant="text" width={COVER_WIDTH * 2} height={typeScale.pageTitle.lineHeight} />
        <Skeleton variant="text" width={COVER_WIDTH} height={typeScale.body.lineHeight} />
      </View>
    );
  } else if (failed) {
    // errorCode is undefined when the rejection was not a CatalogueFailure at
    // all — a bug rather than a condition D14 has copy for, so this falls back
    // to the same honest generic line the unreachable branch below uses.
    const variant = errorCode === undefined ? 'not_ready' : catalogueErrorVariant(errorCode);
    const message = errorCode === undefined ? GENERIC_MESSAGE : CATALOGUE_ERROR_COPY[errorCode];
    body = (
      <View style={styles.centre}>
        <ErrorState variant={variant} message={message} onRetry={retry} />
      </View>
    );
  } else if (detail === null) {
    // Unreachable: `finally` clears `loading` only after one of the two branches
    // above has been given a value. Present so the compiler can narrow, and so a
    // future change that breaks that invariant shows a retry rather than a blank
    // screen — same guard as InstitutionDetailScreen.
    body = (
      <View style={styles.centre}>
        <ErrorState variant="not_ready" message={GENERIC_MESSAGE} onRetry={retry} />
      </View>
    );
  } else {
    // The only place workType is read for presentation. Today this is always
    // 'book' — see the header comment — but the branch is real and the article
    // side is exercised directly in tests rather than left unwritten.
    const effectivePending: ActionId | undefined =
      pendingAction ?? (downloadProgress.status === 'downloading' ? 'download' : undefined);
    body =
      detail.workType === 'article'
        ? renderArticleContent(detail, handleAction, effectivePending, licenceMessage, articleContext)
        : renderBookContent(
            detail,
            handleAction,
            effectivePending,
            licenceMessage,
            coverFailed,
            () => setCoverFailed(true),
          );
  }

  return (
    <View style={styles.screen}>
      {/* Overlays whatever is above, in every state — the library stays usable
          behind it (§State: "offline means degraded but usable"). */}
      <OfflineBanner visible={!isOnline} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  // WHITE, NOT `surface`. `surface` was doing this job when it was #F8F9FA and
  // read as near-white; the brand palette makes it #EBF0FF Cornflower Neutral,
  // which is a card tint and not a page. Both mockups draw a white page with
  // tinted furniture on top, so the page takes `white` and `surface` goes back
  // to what tokens.ts says it is for — cards and section backgrounds, including
  // ActionBar's own footer band, which now separates from the page instead of
  // disappearing into it.
  screen: {
    flex: 1,
    backgroundColor: color.white,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: {
    alignItems: 'center',
    padding: space.lg,
    gap: space.md,
  },
  // Screen 05. LEFT-RANGED, not centred: the cover centres itself (see `cover`)
  // and everything under it shares the left margin. The extra bottom padding
  // clears the pinned ActionBar so the last row can be scrolled out from behind
  // it. No `alignItems` — the default `stretch` is what lets the rules and the
  // Table of Contents row run the full column width.
  content: {
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  // Both scroll regions. `flex: 1` is what leaves the pinned ActionBar below the
  // scroll the rest of the height instead of pushing it off-screen.
  scroll: {
    flex: 1,
  },
  articleScroll: {
    flex: 1,
  },
  // NO `alignItems` OVERRIDE, deliberately. The default `stretch` is what lets
  // the tab divider and the abstract run the full column width; text is
  // left-ranged by default, so left alignment needs no property at all. The two
  // children that must not stretch — the badge and the inline tags — set their
  // own `alignSelf`, which is the rule AccessTierBadge already follows.
  //
  // The extra bottom padding clears the pinned ActionBar, so the last line of a
  // long abstract can still be scrolled clear of it.
  articleContent: {
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.md,
  },
  // Title and authors as one tight unit — xs against the md gaps between the
  // sections below it.
  articleHeader: {
    gap: space.xs,
  },
  // `alignSelf` rather than the parent centring everything: the jacket is the
  // one element on this screen with an axis worth centring on. Elevation from
  // the token set, so the cover sits ON the white page the way the mockup draws
  // it rather than being a flat rectangle cut out of it.
  coverWrap: {
    alignItems: 'center',
    // Tight, not loose — the title belongs to the cover above it, not a
    // separate block with its own breathing room.
    marginBottom: space.lg,
  },
  cover: {
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    borderRadius: radius.card,
    backgroundColor: color.border,
    ...elevation.card.ios,
    ...elevation.card.android,
  },
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  titleColumn: {
    flex: 1,
    gap: space.xs,
  },
  // A small, secondary icon button — Share is not this page's main action,
  // so it takes none of the visual weight the ActionBar's Read/Download get.
  // Same shape as JournalScreen's own `shareIconButton`.
  shareIconButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: color.border,
  },
  // Aleo, tight tracking — the same treatment Catalogue's own book titles
  // (`cardTitle`) use, since a title is exactly that "editorial content" case
  // the brand guide reserves Aleo for. Size/line-height stay `pageTitle`'s
  // own (this is the biggest, most important text on the page), only the
  // family and tracking change.
  title: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: typeScale.pageTitle.size,
    lineHeight: typeScale.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  subtitle: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
  // "By" in the body colour; the names nested inside it take the link colour.
  byLine: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
  byLineNames: {
    color: color.primary,
  },
  // Screen 04's title. A size step below the book's own `title` (22 vs 24) —
  // an article title now has real content underneath it (journal context
  // above, published date/badge/abstract/subjects below), so it no longer
  // needs to be the single largest element carrying the whole page.
  articleTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.2,
    color: color.textPrimary,
  },
  // PRIMARY, NOT `textPrimary`. The mockup sets the author line in its link
  // colour, and an author IS a destination on the web original. Nothing here
  // navigates yet — there is no author endpoint — so this is the one place the
  // screen takes a mockup colour without the mockup's behaviour. It reads as
  // emphasis rather than as a promise because it carries no chevron, no
  // underline and no `accessibilityRole="link"`; the moment an author route
  // exists this becomes a Pressable and nothing about the colour changes.
  articleAuthors: {
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.primary,
  },
  metaBlock: {
    gap: space.xs,
    marginTop: space.sm,
  },
  // The hairline that fences the metadata list off from the badge above it, as
  // the mockup draws it. `border` rather than a tint, and hairline rather than
  // 1px, so it stays a division and not a line to read.
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginBottom: space.sm,
  },
  // Glyph and text on one row.
  metaRowLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // D12's queue position: a status line, styled as metadata rather than as an
  // action, because that is what it is.
  queuePosition: {
    fontFamily: typeScale.meta.fontFamily,
    fontSize: typeScale.meta.size,
    lineHeight: typeScale.meta.lineHeight,
    color: color.textSecondary,
  },
  metaRow: {
    fontFamily: typeScale.meta.fontFamily,
    fontSize: typeScale.meta.size,
    lineHeight: typeScale.meta.lineHeight,
    color: color.textSecondary,
  },
  // Only inside `metaRowLine`, never on the article layout's standalone date —
  // `flex: 1` here wraps a long "Published … by …" under itself instead of
  // pushing past the right margin, but in a column parent it would stretch the
  // line vertically instead.
  metaRowText: {
    flex: 1,
  },
  // Article-only. No `marginTop` any more: `articleContent`'s own `gap` spaces
  // it off the badge above, and the old margin stacked on top of that.
  abstractBlock: {
    gap: space.xs,
  },
  // No marginTop of its own: abstractBlock's own gap already spaces it under
  // the SectionHeader, and description's margin would double it up.
  abstractText: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textPrimary,
  },
  // Format and access tier, side by side — see the render's own comment for
  // why these two share a row instead of stacking.
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // `alignSelf` now that `content` no longer centres its children — same one
  // line AccessTierBadge sets on itself, and for the same reason: a chip that
  // stretches to the column width stops looking like a chip.
  formatStrip: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  formatStripLabel: {
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.textPrimary,
  },
  // Subjects — a wrapping row of static pills (real data, not a control; see
  // SubjectsRow's own header comment for why this isn't the interactive
  // `SubjectChip`). Outlined in the primary colour, matching `SubjectChip`'s
  // own unselected look so a reader who has seen subjects elsewhere in the
  // app recognises the shape, without borrowing a component built for a
  // press this row does not have.
  subjectsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  subjectChip: {
    alignSelf: 'flex-start',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: color.primary,
  },
  subjectChipLabel: {
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.primary,
  },
  // Same border/radius/tint language as JournalScreen's own "Browse this
  // journal" card, so this reads as part of the same journal feature rather
  // than a one-off box invented for this screen.
  publishedInCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  publishedInText: {
    flex: 1,
    gap: 2,
  },
  publishedInLabel: {
    ...typeScale.smallLabel,
    color: color.textSecondary,
  },
  publishedInJournal: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.textPrimary,
  },
  publishedInIssue: {
    ...typeScale.cardMeta,
    color: color.textSecondary,
  },
  // Separates the journal-identity half of the card from the article-
  // specific facts half, when both are present — a hairline rather than
  // extra whitespace alone, so the two feel like distinct groups of facts
  // rather than one run-on list.
  publishedInDivider: {
    marginTop: space.xs,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    gap: 2,
  },
  // No journal context to divide from — e.g. an article reached outside the
  // journal drill-down that still carries a published date/page count.
  publishedInNoDivider: {
    gap: 2,
  },
  // Sits between the scroll and the action bar — above the tap target, visible
  // without scrolling, so the reader does not wonder why the button did nothing.
  // `error` colour matches the established error text pattern (ReaderPreferencesScreen).
  licenceError: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.error,
    backgroundColor: color.white,
  },
});
