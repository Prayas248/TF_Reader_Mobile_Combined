// src/store/articleJournalStore.ts
// Which journal an article belongs to, for articles reached through the
// journal drill-down — the one fact Library needs to group an article under
// its journal instead of showing a bare title, and to route back to it.
//
// WHY THIS EXISTS AS ITS OWN STORE, NOT A FIELD ON DownloadRecord/Loan/
// Bookmark. None of those three shapes has anywhere to put it: `Bookmark` is
// a frozen contract owned by another team's sync layer (`@/shared/contracts`)
// and is not this repo's to extend; `Loan`/`Hold` are server-sourced and
// deliberately session-only (see `downloadStore.ts`'s own comment); and
// duplicating this field into all three would mean three write sites instead
// of one. A single, separate, non-frozen lookup keyed by itemId — the one
// identity all three already share — needs none of that.
//
// WRITTEN FROM EXACTLY ONE PLACE: `ItemDetailScreen.tsx`'s `fetchItem()`
// success callback, the same place `recentlyViewedStore.recordView` already
// fires unconditionally on every resolved fetch. It records on every article
// VIEW reached via the journal flow, regardless of whether the reader later
// downloads, borrows, or bookmarks it — Library then intersects this against
// whichever of those three actually happened, which is what answers "which
// articles from this journal are in my library" without a fourth concept of
// "read".
//
// SAME PATTERN AS recentlyViewedStore: Zustand, persisted through the shared
// `storage` AsyncStorage wrapper. A plain object keyed by itemId rather than
// an array, since every read here is "does this itemId belong to a journal,
// and which one" — an array would mean scanning it on every Library row.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import storage from '@storage/storage';

export interface ArticleJournalMembership {
  journalWorkId: string;
  institutionId: string;
  journalTitle: string;
  volumeTitle?: string;
  issueTitle?: string;
  // The journal's own cover, for Library's Journals tab (`groupArticlesByJournal`)
  // to show one — Library has no other way to reach a journal's cover for a row
  // it never independently fetched. See `ArticleContext`'s own doc for the source.
  coverUrl?: string;
}

interface ArticleJournalState {
  /** itemId -> which journal it belongs to. */
  membership: Record<string, ArticleJournalMembership>;
  recordMembership: (itemId: string, membership: ArticleJournalMembership) => void;
  clear: () => void;
}

export const useArticleJournalStore = create<ArticleJournalState>()(
  persist(
    (set) => ({
      membership: {},

      recordMembership: (itemId, membership) =>
        set((state) => ({ membership: { ...state.membership, [itemId]: membership } })),

      clear: () => set({ membership: {} }),
    }),
    {
      name: 'article-journal-membership',
      storage: createJSONStorage(() => storage),
      version: 1,
    },
  ),
);
