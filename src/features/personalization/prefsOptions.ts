// src/features/personalization/prefsOptions.ts
// The pickable values for the Theme and Font sections of the reader preferences
// screen, as data rather than as JSX.
//
// WHY A SEPARATE FILE. Both lists are PROVISIONAL (see below), so they will
// change once Hruthik signs off. Keeping them out of the section components
// means that change is one edit to a labelled array, not a hunt through render
// code — and it is reviewable on its own.
//
// TabItem, NOT A LOCAL SHAPE. `Tabs` is the control both sections render, and
// CONVENTIONS §2 says to import the type rather than retype it. Anything in
// these arrays is therefore already the shape the control accepts, and `id` is
// the value written to the store while `label` is the only thing on screen.
import type { TabItem } from '@components/Tabs';
import type { LayoutPrefs, ReduceMotion, Theme } from '@/shared/contracts';

// ─── Theme ───────────────────────────────────────────────────────────────────

// `id` is typed as `Theme` rather than `string`, so a typo or a renamed union
// member is a compile error here instead of a value the reader silently cannot
// apply. `satisfies` keeps that check while still handing `Tabs` a TabItem[].
type ThemeOption = TabItem & { id: Theme };

// FOUR OF THE UNION'S FIVE MEMBERS. `highContrast` is deliberately absent, and
// as of Hruthik's FINAL contract (2026-09-02) that is settled rather than
// cautious: contrast lives in exactly one place, `accessibility.display
// .highContrast`, and the `Theme` union's 'highContrast' member is deprecated.
// The two are independent — dark plus high contrast is a valid combination — so
// offering it here would be a second, conflicting control for one setting.
// DO NOT REINTRODUCE IT.
//
// A STORED 'highContrast' IS THEREFORE UNMATCHED, AND THAT IS HANDLED RATHER
// THAN PREVENTED. Prefs are a per-user singleton synced LWW across devices, so
// the value can arrive from somewhere this screen does not control. `Tabs`
// renders no active segment when `activeId` matches nothing, which is the right
// answer — a wrong highlight is worse than no highlight — and the sections say
// so out loud rather than leaving the control looking broken. See
// ReaderPreferencesScreen.ThemeSection.tsx.
export const THEME_OPTIONS = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'system', label: 'System' },
] as const satisfies readonly ThemeOption[];

// ─── Font family ─────────────────────────────────────────────────────────────

// PROVISIONAL — PENDING HRUTHIK'S SIGN-OFF, and more provisional than the theme
// list above. These seven come from the t4targaryen integration contract as
// relayed in the Week 3 plan; they are NOT ratified in `prefs.ts`, which types
// `FontPrefs.family` as an open `string` and offers only 'Georgia' and 'system'
// as comment examples. So this array is the only place in the repo that names
// them, and it is a starting point rather than a product requirement. Keshav
// sent the confirmation question on Monday; expect the strings to be renamed.
//
// `id` STAYS `string`, MATCHING THE CONTRACT. `FontPrefs.family` is a plain
// string precisely because the reader accepts faces this list does not know
// about, including a user-supplied file via `customFontUri`. Narrowing it to a
// union here would be this screen inventing a constraint the contract does not
// have — and it would break the moment a stored value came from outside the
// list, which is exactly the case the sections already handle.
//
// 'system' IS LOWERCASE ON PURPOSE. It is the one value the contract does fix:
// `DEFAULT_PREFS.font.family` is `'system'`. The label is capitalised for
// display; the stored id is not.
//
// NOTHING IS PREVIEWED IN ITS OWN FACE. CONVENTIONS §5 — "Never set
// fontFamily. The loader applies it globally" — and none of these six faces is
// installed in this app anyway. They are labels naming a choice the READER
// applies to book content; they never restyle our own chrome.
export const FONT_FAMILY_OPTIONS = [
  { id: 'system', label: 'System' },
  { id: 'Inter', label: 'Inter' },
  { id: 'Poppins', label: 'Poppins' },
  { id: 'Roboto', label: 'Roboto' },
  { id: 'Merriweather', label: 'Merriweather' },
  { id: 'Lora', label: 'Lora' },
  { id: 'Montserrat', label: 'Montserrat' },
] as const satisfies readonly TabItem[];

// ─── Layout ──────────────────────────────────────────────────────────────────

// `id` typed against the contract so a rename to the union member is a compile
// error here instead of a silent mismatch with the epub.js rendition API.
type FlowOption = TabItem & { id: LayoutPrefs['flow'] };
type SpreadOption = TabItem & { id: LayoutPrefs['spread'] };

export const FLOW_OPTIONS = [
  { id: 'paginated', label: 'Paginated' },
  { id: 'scrolled-doc', label: 'Scrolled' },
] as const satisfies readonly FlowOption[];

export const SPREAD_OPTIONS = [
  { id: 'single', label: 'Single' },
  { id: 'double', label: 'Double' },
] as const satisfies readonly SpreadOption[];

// ─── Typography — font size ──────────────────────────────────────────────────

// A RANGE, NOT PRESETS — per the Personalization Settings UI requirements
// (2026-09-11), font size is a stepper/slider over 10-32pt, replacing the six
// fixed presets this section used to offer. Centralised the same way
// FONT_SCALE_MULTIPLIER is below: the hook's clamp and the section's slider
// bounds read one number each, rather than two literals kept in step by hand.
export const FONT_SIZE_PT = {
  min: 10,
  max: 32,
  step: 1,
} as const;

// ─── Layout — spread on a phone-sized screen ────────────────────────────────

// epub.js gates `rendition.spread('double')` at this exact viewport width
// (its own `minSpreadWidth`), so below it "double" is a no-op for EPUB — see
// prefs.ts's ZoomPrefs/LayoutPrefs and the Settings UI requirements' §7. PDF
// spread has no such gate and works at any width; this constant only decides
// whether THIS SCREEN offers the "Double" option, not what the reader does
// with a value already stored.
export const EPUB_SPREAD_MIN_WIDTH = 800;

// ─── Zoom (PDF only) ─────────────────────────────────────────────────────────

// 1.0 = 100%. `ZoomPrefs.level` is unbounded in the contract (same reasoning
// as FONT_SCALE_MULTIPLIER below), so the on-screen bounds live here.
export const ZOOM_LEVEL = {
  min: 0.5,
  max: 3.0,
  step: 0.25,
} as const;

// ─── Accessibility — font scale multiplier ──────────────────────────────────

// THE RANGE IS DATA HERE, not literals in the screen. Hruthik's contract
// (v1.1 §2.1) fixes the default at 1.0 but leaves the on-screen bounds to us
// and says so explicitly — "the type itself is unbounded". A number we chose
// and a number the contract chose belong in one reviewable place rather than
// split between a screen file and a document.
//
// THE BOUNDS ARE THE UI'S GUARD, NOT THE STORE'S. Same division of labour as
// Typography: `savePrefs` accepts any number, so the clamp happens before the
// call. `step` keeps a dragged value on the grid; `min`/`max` are what a clamp
// reads.
//
// NO `default` KEY, DELIBERATELY. `DEFAULT_PREFS.accessibility.text
// .fontScaleMultiplier` is authoritative, and a second copy here would be one
// more thing to keep in step by hand for no gain.
export const FONT_SCALE_MULTIPLIER = {
  min: 0.8,
  max: 1.5,
  step: 0.1,
} as const;

// ─── Accessibility — reduce motion ──────────────────────────────────────────

// THREE-WAY, NEVER A CHECKBOX. Hruthik's contract states this twice (v1.1 §2.2
// and again in §3): store the raw 'system' | 'on' | 'off' and do not collapse it
// to a boolean on the way in. Resolving it to an effective boolean against live
// OS state is the reader's job, not this screen's — a boolean written here would
// throw away the difference between "the user chose off" and "the user chose
// whatever the OS says", which is the whole point of the tri-state.
//
// `id` IS TYPED AGAINST `ReduceMotion`, not left as a bare string, so a typo or
// a renamed union member is a compile error here — the same protection
// `THEME_OPTIONS` and the two Layout arrays already have.
type ReduceMotionOption = TabItem & { id: ReduceMotion };

export const REDUCE_MOTION_OPTIONS = [
  { id: 'system', label: 'System' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
] as const satisfies readonly ReduceMotionOption[];
