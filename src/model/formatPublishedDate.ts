// src/model/formatPublishedDate.ts
// Extracted from ItemDetailScreen.tsx once a second caller (journal/ArticleList.tsx,
// for each article row's date) needed the same formatting — one place, not two
// copies of MONTH_NAMES.
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

// `published` is whatever date string the feed sent — normalize.ts documents
// it as ISO ('YYYY-MM-DD...'), same shape the fixtures use. Falls back to the
// raw string rather than throwing or hiding the date entirely if that shape
// is ever wrong — a slightly-off-format date is still more useful to a reader
// than no date at all.
export function formatPublishedDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  const monthName = MONTH_NAMES[Number(month) - 1];
  if (monthName === undefined) return iso;
  return `${Number(day)} ${monthName} ${year}`;
}
