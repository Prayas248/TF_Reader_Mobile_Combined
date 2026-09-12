# Stitch Prompts — TF Reader

Ready-to-paste prompts, in generation order. Companion to `DESIGN.md`.

## How to run this

1. Open **stitch.withgoogle.com**, create a new **Mobile** project.
2. Switch to **Experimental mode** (Gemini 2.5 Pro). Standard mode drops constraints from long
   prompts; this brief is long on purpose.
3. Paste **Prompt 0** first and let it generate. That establishes the visual system.
4. Then work through prompts 1–14 **in the same chat**. Each one leans on the style already
   established, so they stay short.
5. If you start a fresh chat, re-paste the **STYLE BLOCK** from Prompt 0 ahead of whatever
   screen you want.
6. Generate book surfaces (1–3) first and iterate until the card and cover look right. Every
   later screen reuses them, so fixing them early saves generations.
7. Export to Figma when happy. Ignore Stitch's HTML/CSS output — this app is React Native.

**If a result drifts** (generic SaaS look, wrong fonts, purple creeping in), reply in the same
chat with the **Correction prompt** at the bottom of this file.

---

## Prompt 0 — Establish the style

> I'm designing **TF Reader**, a Taylor & Francis mobile app for scholarly books, journal
> articles and audiobooks. Users are university researchers and students who access content
> through an institutional subscription — there are no prices, ratings or social features.
>
> Before we design screens, establish this visual system and hold it for everything that follows.
>
> **Mood:** elegant, minimalist, academic. A quiet, well-lit reading room — considered and
> unhurried, closer to a university press catalogue than a streaming app. Generous whitespace,
> clear typographic hierarchy, restrained colour, no ornament.
>
> **Colour — use only these, never any other hue:**
> Ultramarine `#003CB2` primary buttons and links · Indigo `#002244` app bar, dark fills and
> gradient starts · Carbon `#283857` headings and body · Slate `#3C4E69` metadata · Cornflower
> Neutral `#EBF0FF` **the page background of every screen** · White `#FFFFFF` cards and sheets ·
> Cloud `#E9E9EC` borders and skeleton bars · Mint Dark `#00786E` Open Access · Cornflower
> `#505AFF` on tint `#D4E3FF` Subscription · Coral Dark `#BF1B4F` on tint `#FBE9EE` errors ·
> Saffron `#EEAF00` waitlist.
> Blue must be visibly present in every layout — roughly 60% blue, 30% secondary, 10% neutral.
> Absolutely no purple, teal, orange, pink or warm grey.
>
> **Type — two families only:**
> **Open Sans** for all interface text. **Aleo** (slab serif) sparingly, for book titles,
> editorial headlines and pull-out statistics only — never for buttons, tabs or labels.
> Weights 300, 400 and 700 only; never 500 or 600. Never Inter, Poppins, Montserrat or Roboto.
> Scale: page title 24/32 bold · section header 18/24 bold · body 15/22 regular · metadata 13/18
> light · button 15/20 bold · small label 12/16 regular · book title 18/22 Aleo bold · tiny tag
> 10/14 bold. No all-caps body copy.
>
> **Geometry:** card radius 8px, tile radius 12px, sheet top radius 16px, pills fully rounded.
> Spacing on a 4/8/16/24/32 grid. Screen padding 16px.
>
> **Depth:** white cards on the tinted page, hairline `#E9E9EC` border, very soft shadow. Book
> covers carry a *deeper* shadow than the card beneath them, so a cover reads as an object lying
> on the card.
>
> **The central idea — "the app is a shelf, every book is a jacket":**
> Every book cover is a flat rectangle at a true **2:3 ratio**, with a hairline edge, a soft drop
> shadow, and a thin darker **spine strip down its left edge**. A small dark format tag (`EPUB`,
> `PDF` or `AUDIO`) sits on the cover's bottom-right corner, straddling its edge — Indigo at 72%,
> white 10px bold text.
>
> **Books with no cover artwork get a designed jacket, not a grey placeholder.** It is a blue
> gradient rectangle at the same 2:3 ratio carrying the real title in Aleo Bold white, left-ranged,
> up to five lines, with a thin white rule and the publisher in small light white text at the foot.
> Use one of four blue gradients: `#002244`→`#003CB2`, `#002E7A`→`#1E50D2`, `#003CB2`→`#1E50D2`,
> `#002244`→`#002E7A`. Varying only within the blues is deliberate — a shelf of these should read
> like a uniform publisher's series, the way a rack of Penguin Classics does.
>
> **Never generate:** glassmorphism, neumorphism, frosted blur, 3D or perspective book mockups,
> page-curl effects, pill-shaped cards, floating action buttons, hamburger menus, gradient text,
> drop caps, emoji, filled or duotone icons, star ratings, prices, "Buy" buttons, avatars, or
> dark mode. Icons are thin single-weight line icons.
>
> **For this first output:** show me a style tile — the colour palette as labelled swatches, the
> type scale as specimens, a book card, a book cover tile, a fallback typographic jacket, the
> three access badges, and a primary button.

---

## Prompt 1 — Catalogue Home ★ start here

> Design the **Catalogue Home** screen. Vertical scroll on the `#EBF0FF` ground.
>
> Top: an Indigo `#002244` app bar with the "Taylor & Francis" wordmark in white on the left and,
> on the right, a translucent white pill (14% opacity) holding a small building outline icon, the
> text "Univ. of Manchester", and a check mark. White status bar glyphs.
>
> Then a **full-bleed hero** running edge to edge, rounded only at the bottom (16px), with a
> diagonal Indigo→Ultramarine gradient. Inside, left-ranged with generous padding: a small
> translucent stat pill reading "Over 140,000 peer-reviewed titles" in Aleo Light, a large Aleo
> Bold headline "The Scholarly Archive", one line of body copy "Books, journals and audiobooks
> from Taylor & Francis, wherever you research.", and a single white pill button "Explore all
> titles" with Ultramarine text. One very faint white circle bottom-right at 6% opacity.
>
> Then a **featured shelf**: a bold 18px section header "Featured this month" with an Ultramarine
> "See all" link right-aligned, and below it a horizontally scrolling row of book cover tiles
> about 176px wide. The row **bleeds past the screen padding** so the next tile is half-visible at
> the right edge. Each tile: cover at 2:3 with spine and format tag, then publisher and access
> badge on one row, then the title in Aleo Bold over two lines, then the author.
>
> Then **two vertical shelves** — "New in Environmental Science" and "Open Access highlights" —
> each a section header with "See all", then three white book cards. Each card: a 112px 2:3 cover
> on the left with spine, shadow and format tag; on the right the publisher and access badge on
> one line, the title in Aleo Bold over up to two lines, the author line, and a small "312 pp."
> at the foot. **No chevrons.**
>
> Mix real covers and fallback typographic jackets across the shelves — most books here have no
> artwork, so the jackets should look intentional and in-series.
>
> Then the bottom tab bar: white with a hairline top border and four tabs — Catalogue, Search,
> Library, Profile — thin line icons over 12px labels, Catalogue active in Ultramarine with a
> short 2px underline, the rest Slate.

## Prompt 2 — Shelf listing (2-up grid)

> Same app and style. Design the **Shelf listing** screen — a pushed screen, so the app bar shows
> a thin white back chevron and the title "Environmental Science" instead of the wordmark.
>
> Below: an outlined pill button "Filter & Sort" at top-left with a small sliders icon. Then a
> **2-column grid of book cover tiles** with 16px gutters, six rows deep. Each tile is the cover
> tile from the style system — 2:3 cover with spine and format tag, then publisher with access
> badge, the Aleo Bold title over exactly two reserved lines, and the author on one line, so
> tiles align perfectly across the grid.
>
> The covers should dominate this screen — they are the content. Roughly half real artwork, half
> fallback typographic jackets in the blue series.
>
> At the foot: a small centred Slate line "Showing 24 of 312" and an Ultramarine "Load more" text
> button. Bottom tab bar with Catalogue active.

## Prompt 3 — Item Detail (book)

> Same app and style. Design the **Item Detail** screen for a single book. **No bottom tab bar.**
>
> App bar with a back chevron and the title "Item Details".
>
> A soft gradient scrim from Indigo down to `#EBF0FF` across the top third of the page. The book
> cover sits **centred and large** on it, about 180px wide at 2:3, with a strong drop shadow, its
> spine strip, and the format tag on its corner — floating like an object.
>
> Everything below is left-ranged: "Climate Change and the Coastal City" in Aleo Bold at 24px, a
> lighter subtitle line, then "By Jane Okonkwo, Ravi Menon" with the names in Ultramarine. Then a
> row holding a small grey `EPUB` tag and a Mint Dark "Open Access" badge.
>
> A thin Cloud rule, then four metadata lines, each a small thin line icon plus text:
> "ISBN 9780367211745", "312 pages", "Published 30 September 2020 · Routledge".
>
> Then a bold "About this title" section header and three paragraphs of academic description,
> clamped with an Ultramarine "Read more" link.
>
> **Pinned to the bottom**, outside the scroll: a white bar with a hairline top border holding a
> full-width Ultramarine pill button "Read" and an outlined "Download" button beside it.

## Prompt 4 — Search (three states)

> Same app and style. Design the **Search** screen in three variations, side by side.
>
> All three share a fixed top block: a white rounded search field with a thin magnifier icon left
> and a microphone icon right, a small Slate helper line "Search titles, authors and subjects",
> and an outlined "Filter & Sort" pill.
>
> **A — Idle.** A "Recent searches" section header with an Ultramarine "Clear" action, then three
> rows each with a thin clock icon, the query text, and a small rotated arrow on the right. Then a
> "Recently viewed" section header and two book cards.
>
> **B — Results.** A small Slate line "1,245 results", then a 2-column grid of book cover tiles,
> four rows deep.
>
> **C — Empty.** A centred white card with a thin magnifier icon, the line "No books match
> 'quantum ethnography'.", a short bulleted list — "Checking your spelling", "Using different
> keywords", "Searching for a broader topic" — and an outlined "Clear search" pill. Below the
> card, a "Browse instead" section header and four full-width single-line rows in cycled blue
> tints, each with a subject name and a thin chevron.

## Prompt 5 — Library

> Same app and style. Design the **Library** screen.
>
> A pinned header block that does not scroll: "Library" in Aleo Bold 24px, the line "Your
> scholarly content and access in one place." in Slate, and a small info-icon caption "Access is
> checked automatically and can expire even while you're offline."
>
> Then a pinned **segmented pill rail** filling the width with five tabs — All, Borrowed,
> Downloads, Bookmarks, Premium. The active pill is filled Ultramarine with white text; the rest
> are transparent with Slate text. "All" is active.
>
> Then a scrolling list of white book cards. Vary the foot line on each so the states read
> clearly: one with "Due 14 March" and a Subscription badge; one with "Downloaded" and a small
> check icon; one with "Access expires: 2 April" and an Elite badge; one with "#3 of 7" and a thin
> Saffron progress bar about 40% filled; one with "4 bookmarks" and no cover, just a title row.
>
> Bottom tab bar with Library active.

## Prompt 6 — Institution picker

> Same app and style. Design the **Change institution** screen.
>
> A page header "Change institution" in Aleo Bold with the line "Search for your institution to
> access its subscribed content." Then a white search field "Search for your institution".
>
> Then a prominent **"Current institution" card** on a `#EBF0FF` tint with a Cloud border: the
> institution emblem on a white circular disc at 64px, and beside it "University of Manchester" in
> Aleo, "United Kingdom" in Slate, and a Mint Dark check with "Active access".
>
> Then a "Recent institutions" section header and a clipped white group of two rows. Then an "All
> institutions" section header and a long list of rows: a 48px emblem on the left, the institution
> name over up to two lines, the country beneath in Slate.
>
> **Important:** show a mix of real emblems and the fallback — a Cornflower Neutral `#EBF0FF` disc
> with the institution's two initials in Ultramarine Open Sans Bold. Several rows should use the
> monogram, because emblems often fail to load.

## Prompt 7 — Institution detail

> Same app and style. Design the **Institution detail** screen — a simple centred column on the
> tinted ground. A large emblem at 80px (or an initials monogram disc), "Delft University of
> Technology" in Aleo Bold centred and wrapping to two lines, "Netherlands" in Slate beneath, a
> full-width Ultramarine pill button "Select this institution", and a plain Ultramarine text
> button "Back". Lots of whitespace. App bar shows a back chevron and "Institution".

## Prompt 8 — Sign-in sheet

> Same app and style. Design the **Sign-in bottom sheet**, shown over a dimmed Catalogue Home.
> The backdrop is Indigo at 50% opacity. The sheet is white, 16px top corners, about 60% of the
> screen height, with a small grey grab handle centred at the top.
>
> Inside, centred: "Sign in" in Aleo Bold, then a block with "University of Manchester" in bold
> and "Manchester · United Kingdom" in Slate beneath, then a full-width Ultramarine pill button
> "Sign in through your institution", then a plain Slate "Cancel" text button.

## Prompt 9 — Access gate sheet

> Same app and style. Design the **Access gate bottom sheet** over a dimmed Item Detail screen.
> Same sheet chrome as before.
>
> Inside: "Choose how to access" in Aleo Bold. Then a small block — the Slate label "You're trying
> to access:", the book title in bold, and the authors in Slate. Then **two selectable method
> cards**, stacked: each a white card with an 8px radius and a Cloud border, containing a thin
> line icon on the left, a bold label, and a Slate sub-label. First: building icon, "Through my
> institution", "Sign in via your university". Second: person icon, "Personal account", "Sign in
> with email and password". Then a plain centred "I'll decide later" text button.

## Prompt 10 — Personal account

> Same app and style. Design the **Personal account** screen, in two variations side by side.
>
> **A — Sign in.** Page header "Sign in" in Aleo Bold with a short intro line. A stacked form of
> white text fields with 8px radius, Cloud borders and small Slate labels above each: "Email"
> with placeholder "you@university.ac.uk", and "Password". A full-width Ultramarine pill button
> "Sign in". At the foot, centred: "New to Taylor & Francis?" in Slate with an Ultramarine link
> "Create an account".
>
> **B — Create account, with an error.** Same layout plus a "Confirm password" field, and button
> "Create account". Show the Email field in its **error state**: a Coral Dark `#BF1B4F` border and
> a short Coral Dark message beneath reading "Enter a valid email address."

## Prompt 11 — Profile

> Same app and style. Design the **Profile** screen, scrolling on the tinted ground.
>
> Page header "Profile" with the line "Manage your account, access and reading preferences."
>
> Then an **identity card**: white, bordered, containing the institution emblem on a white disc,
> "University of Manchester" in Aleo Bold, "Institutional access" in Slate, a Mint Dark check with
> "Active access", and two small building-icon lines for the name and country.
>
> Then a "Change institution" action row with a chevron.
>
> Then two grouped white cards, each with a small Slate group label above it. **"Reader
> experience"**: Reading Preferences, Accessibility, Download & Offline — each a row with a thin
> line icon, a label and a chevron. **"Preferences & system"**: Notifications, Privacy & Security,
> About T&F Reader.
>
> Then a Coral-tint `#FBE9EE` card, centred, with a Coral Dark log-out line icon and "Sign out" in
> Coral Dark.
>
> Bottom tab bar with Profile active.

## Prompt 12 — Reader (EPUB)

> Same app and style, but **this screen deliberately recedes** — the reading surface is neutral
> and only the toolbars carry the brand. No bottom tab bar.
>
> Design the **Reader** screen. A slim white top toolbar with a hairline bottom border holding
> four thin line icons, evenly spaced: a magnifier ("search this title"), a bookmark, an
> accessibility person glyph, and a small menu. The book page fills everything below — a page of
> academic prose set in a serif at comfortable measure, near-black on white, with generous side
> margins and a chapter heading at the top.
>
> A slim white bottom bar with a hairline top border: "‹ Prev" on the left in Ultramarine, a
> centred "Contents (24)" text button, "Next ›" on the right.
>
> Also show a second variation with the **Contents panel open** — an opaque white overlay across
> the reading area headed "Contents", listing twelve chapter entries with soft fade edges at top
> and bottom.

## Prompt 13 — Audio player

> Same app and style. Design the **Audio player** screen. No bottom tab bar. App bar with a back
> chevron and the book title.
>
> A white page with generous padding. The book cover **large and centred**, about 200px wide at
> 2:3, with a strong shadow and its spine strip. Beneath it, the title in Aleo Bold centred over
> two lines, then the author in Slate.
>
> Then a scrubber row: elapsed time "1:24:07" on the left, a thin track with the played portion in
> Ultramarine and a round knob, and remaining time "−2:11:53" on the right.
>
> Then a transport row, centred: a "−15s" circular outline button with a rewind arrow, a large
> Ultramarine filled circular play/pause button about 72px, and a "+15s" circular outline button.
>
> Then a row of five small speed pills — 0.75×, 1×, 1.25×, 1.5×, 2× — with 1× filled Ultramarine
> and the rest outlined in Cloud with Slate text.

## Prompt 14 — Reading preferences

> Same app and style. Design the **Reading Preferences** screen. App bar with a back chevron and
> "Reading Preferences".
>
> A page header with the caveat line "These settings apply to EPUB content only. PDFs use their
> own embedded settings." Then four white grouped cards on the tinted ground:
>
> **Theme** — a segmented control of three options showing small swatches: Light (white), Sepia
> (`#F4ECD8`), Dark (`#121212`). Light is active.
> **Font** — an "Aa" icon, a small Slate hint, and a dropdown trigger row reading "Merriweather" with
> a chevron.
> **Layout** — two segmented controls, labelled "Reading style" and "Page view".
> **Typography** — a "Tt" icon, a segmented "Text size" control, then three labelled sliders each
> with a numeric readout on the right: "Line height 1.5×", "Letter spacing 0px", "Page margins
> 16px". Sliders have Ultramarine fills and round knobs.
>
> At the foot, a Coral-tint `#FBE9EE` card with a refresh line icon, "Restore defaults", and the
> Slate sub-line "Resets theme, font, layout, typography and accessibility".

---

## Correction prompt — ground and cards ★ use this one now

The tinted page didn't work: `#EBF0FF` reads muddy across a full screen. The fix is a **white
page with no card boxes** — covers become the only objects. Paste this into the same Stitch chat
to correct every screen already generated:

> Two structural corrections to the whole design system. Apply them to every screen, keeping all
> existing layout, content and hierarchy exactly as it is.
>
> **1. The page background is now plain white `#FFFFFF`, not `#EBF0FF`.** Remove the tint from
> every screen background. Cornflower Neutral `#EBF0FF` is now used *only* for small fills:
> grouped settings cards, the "current institution" card, and the circular initials monogram
> discs. It must never fill a page again.
>
> **2. Remove the card container from every book listing.** Book rows and book tiles must have
> **no card box at all** — no background fill, no border, no corner radius, no card shadow. The
> cover and its text sit directly on the bare white page. Separate one book from the next with
> **about 24px of whitespace and nothing else** — no dividers, no hairlines, no boxes.
>
> **The book cover is now the only object on the screen, and it must carry all the depth.**
> Keep every cover a flat rectangle at a true 2:3 ratio with: a soft drop shadow beneath it, a
> hairline edge, a thin darker spine strip down its left side, and the small dark format tag on
> its bottom-right corner. Make these covers slightly more prominent than before — they are
> doing the work the card boxes used to do.
>
> Boxed white cards still exist in exactly three places, and nowhere else: the grouped settings
> rows on Profile and Reading Preferences, the "current institution" card, and bottom sheets.
>
> Everything else is unchanged: same palette, same Open Sans and Aleo, weights 300/400/700 only,
> same Indigo app bar, same hero gradient, same blue fallback jackets, light theme only.

## Correction prompt — general drift

Paste this when a result wanders off the system in other ways:

> That drifted from the system. Correct it, keeping the layout:
> - Page background is plain white `#FFFFFF`. No page-wide tint.
> - Book listings have **no card box** — no fill, border, radius or shadow around a book. Covers
>   sit on bare white, separated by whitespace only.
> - Only these hues exist: `#003CB2`, `#002244`, `#283857`, `#3C4E69`, `#FFFFFF`, `#E9E9EC`,
>   `#EBF0FF`, `#00786E`, `#505AFF`, `#D4E3FF`, `#BF1B4F`, `#FBE9EE`, `#EEAF00`. Remove every
>   other colour — especially any purple or teal.
> - Interface text is Open Sans. Only book titles and editorial headlines are Aleo. Weights 300,
>   400 and 700 only. No Inter, Poppins, Montserrat or Roboto.
> - Book covers are flat 2:3 rectangles with a hairline edge, soft shadow, and a spine strip on
>   the left. No 3D, no perspective, no page curl.
> - Remove any star ratings, prices, "Buy" buttons, avatars, emoji or filled icons. This is
>   institutional academic access, not a bookstore.
> - Light theme only.

## Variation prompts

Useful follow-ups once a screen is close:

> Show this screen in its **loading state** — replace all content with Cloud `#E9E9EC` skeleton
> bars at exactly the dimensions of the real content. No spinners anywhere.

> Show this screen with the **offline banner** — a Carbon `#283857` bar pinned to the top of the
> content area with white text "You're offline."

> Show this screen in its **empty state** — a centred thin line icon, one short bold line, one
> sentence of guidance, and a single outlined pill button.

> Increase the size of the book covers by 20% and reduce the surrounding metadata to title and
> author only. I want the covers to carry more of the screen.
