# TF Reader — Design Brief

**For:** Google Stitch (and any designer or tool that needs the whole picture)
**Platform:** Mobile, portrait, iOS + Android
**Theme:** Light only
**Brand source:** `TF_Reader_Design_Specification.md` §2, which derives from the official
Taylor & Francis brand guidelines.

> **How to use this with Stitch.** Stitch takes a text prompt plus optional reference images —
> it does not read uploaded files. Paste **§2 The Style Block** at the top of every prompt, then
> append the screen you want from §5. `STITCH_PROMPTS.md` has all of this pre-assembled, one
> ready-to-paste prompt per screen. Use **Experimental mode** for the first generation of each
> screen; it holds long constraint lists far better than Standard mode.

---

## 1. The product in one paragraph

TF Reader is the unified Taylor & Francis reading app: scholarly books, journal articles and
audiobooks from a 140,000-title academic archive, in one place. Its users are researchers,
students and faculty who reach content through an **institutional subscription** — they sign in
via their university, not with a credit card. There are no prices, no ratings, no reviews, no
recommendations and no social features. The app's job is to present serious work seriously, make
access state unambiguous, and get out of the way of reading.

**The feeling to design for:** a quiet, well-lit reading room. Considered, unhurried, a little
austere. Closer to a university press catalogue than a streaming service.

---

## 2. The style block

*Paste this verbatim at the top of every Stitch prompt.*

> Design a mobile app screen for **TF Reader**, a Taylor & Francis scholarly reading app for
> university researchers and students. The aesthetic is elegant, minimalist and academic — a
> quiet reading room, not a content feed. Generous whitespace, clear typographic hierarchy,
> restrained colour, no ornament.
>
> **Colour — use only these, no others:**
> - Ultramarine `#003CB2` — primary buttons, links, active states
> - Indigo `#002244` — app bar, dark fills, gradient starts, overlays
> - Carbon `#283857` — headings and body text
> - Slate `#3C4E69` — metadata, captions, secondary text
> - White `#FFFFFF` — **the page background on every screen**, and sheet surfaces
> - Cloud `#E9E9EC` — borders, skeleton bars
> - Cornflower Neutral `#EBF0FF` — small tinted fills only: grouped setting cards, the
>   current-institution card, initials monogram discs. **Never a page background.**
> - Mint Dark `#00786E` — Open Access badge
> - Cornflower `#505AFF` with tint `#D4E3FF` — Subscription badge
> - Coral Dark `#BF1B4F` with tint `#FBE9EE` — errors, destructive actions
> - Saffron `#EEAF00` — waitlist and queue states
>
> Blue must be visibly present in every layout. Aim for roughly **60% blue, 30% secondary,
> 10% neutral**. Never introduce a hue outside this list — no purple, no teal, no warm greys.
>
> **Typography — two families only:**
> - **Open Sans** for all interface text: page titles, body, buttons, metadata, labels.
> - **Aleo** (a slab serif) used *sparingly*, for book titles, editorial headlines and pull-out
>   statistics only. Never for interface chrome.
> - Weights **300 Light, 400 Regular, 700 Bold** only. Never 500 or 600.
> - Never use Inter, Poppins, Montserrat, Roboto or a system font.
> - Scale: page title 24/32 bold · section header 18/24 bold · body 15/22 regular ·
>   metadata 13/18 light · button 15/20 bold · small label 12/16 regular ·
>   book title 18/22 Aleo bold · tiny tag 10/14 bold.
> - Never set body copy in all-caps.
>
> **Geometry:** card radius 8px, tile radius 12px, bottom-sheet top radius 16px, pills fully
> rounded. All spacing on a **4 / 8 / 16 / 24 / 32** grid. Screen padding 16px.
>
> **Depth — this is the whole trick.** The page is white, and book listings have **no card
> container at all**: no box, no border, no fill, no card shadow. A cover and its text sit
> directly on the white page, separated from the next book by whitespace alone. The cover is the
> only element carrying depth — a hairline edge, a soft drop shadow, a spine strip — so it reads
> as the single object on the screen. Boxed cards survive only for settings groups, the
> current-institution card, and bottom sheets.
>
> **Icons:** thin, single-weight line icons. Never emoji, never filled glyphs, never
> multicolour, never 3D.
>
> Light theme only.

---

## 3. The core idea: "Series Imprint"

**The app is a shelf, and every book is a jacket.**

Three rules follow from it, and they are what make this design distinctive rather than generic:

**1. White page, and no card boxes.** Today every screen *and* every card is the same white with
a hairline between them — so a 1px border does all the separating and nothing has depth. The
instinct is to tint the page. That was tried, rendered, and rejected: Cornflower Neutral is a
chromatic tint that goes muddy across a whole screen. So go the other way and **delete the box**.
A white page with no card chrome leaves the covers as the only objects on it, and whitespace does
the separating. Less furniture, more book.

Blue must still be present in every layout (§2.1's brand rule), and with the box gone it comes
from the Indigo app bar, the gradient hero, the Ultramarine accents, and above all the blue
fallback jackets in §4.3 — which, given how few books carry artwork, will be most of the screen.

**2. Covers are physical objects.** Every cover, everywhere, at a true **2:3 book ratio**, with
a hairline edge, a soft drop shadow, and a thin darker **spine strip down the left edge**. A flat
bitmap on white looks like a thumbnail. These details cost nothing and read instantly as a book.

**3. A book with no cover art still gets a jacket.** See §4.3 — this is the most important
component in the whole brief.

---

## 4. Components

### 4.1 Book row — no container
The workhorse. Used in catalogue shelves, library lists, search results and recently-viewed.
**There is no card around it.** This is the most important instruction in the brief.

```
   bare white page — no box, no border, no fill

   ┌────────┐
   │▌       │  Routledge      ● Open Access
   │▌       │
   │▌ COVER │  Climate Change and the          ← Aleo bold, 2 lines max
   │▌  2:3  │  Coastal City
   │▌       │
   │▌  112px│  Jane Okonkwo, Ravi Menon        ← Open Sans light
   │▌ [EPUB]│
   └────────┘  312 pp.
    ╲ shadow ╱

        24px whitespace — no divider

   ┌────────┐
   │▌ COVER │  CRC Press      ● Subscription
   │▌       │  Urban Water Systems and
   │▌       │  Resilience
   └────────┘

   ▌ = spine    [EPUB] = format tag on the cover
```

- **No card.** No background fill, no border, no radius, no card shadow. The row is a cover plus
  text on the bare white page.
- Rows separate by **24px of whitespace and nothing else** — no hairline dividers.
- **Cover 112px wide at 2:3**, left, top-aligned, 8px radius. It carries a soft drop shadow and a
  hairline edge, and it is the *only* element on the row with either. Spine strip down its left.
- Format tag (`EPUB` / `PDF` / `AUDIO`) sits **on the cover**, bottom-right, straddling its edge.
  Indigo at 72% opacity, white 10px bold text.
- Right column: publisher and access badge on one line, then the Aleo bold title (max 2 lines),
  then the author line, then optional small metadata.
- **No chevron.** The row is obviously tappable.
- Audiobooks get a translucent Indigo wash over the cover with a centred white play triangle.

### 4.2 Book tile — cover
For the featured carousel and the 2-up grids. Cover-forward, no action row.

- Full-width cover at 2:3, 12px radius, format tag on the cover.
- Beneath it, three **fixed-height** lines so tiles side-by-side align perfectly:
  publisher + badge on one row, title over exactly two reserved lines, author on one line.
- Flat — no card shadow. Separation comes from the gap between tiles.

### 4.3 Fallback jacket — the most important component here

**Context Stitch needs to know:** most books in this catalogue have no cover artwork. A generic
grey placeholder would mean the app is mostly grey boxes. So a missing cover gets a *designed*
jacket instead.

```
┌────────────┐   Gradient, one of four blue pairs,
│▓▓▓▓▓▓▓▓▓▓▓▓│   chosen deterministically from the title
│▓          ▓│
│▓ Climate  ▓│   ← the REAL title, Aleo bold, white,
│▓ Change   ▓│     left-ranged, up to 5 lines
│▓ and the  ▓│
│▓ Coastal  ▓│
│▓ City     ▓│
│▓          ▓│
│▓ ───────  ▓│   ← thin white rule at 30%
│▓ Routledge▓│   ← publisher, Open Sans light 10px, white at 70%
└────────────┘
```

The four gradients, **all within the blue ramp**:
| # | From | To |
|---|---|---|
| 1 | Indigo `#002244` | Ultramarine `#003CB2` |
| 2 | `#002E7A` | `#1E50D2` |
| 3 | Ultramarine `#003CB2` | `#1E50D2` |
| 4 | Indigo `#002244` | `#002E7A` |

Staying inside one tonal range is a brand rule (*"do not mix secondary tonal ranges"*), and it
turns the constraint into the idea: a shelf of these reads as a **uniform publisher's series**,
like a rack of Penguin Classics — deliberate, not broken.

Same 2:3 ratio, same radius, same shadow and spine as a real cover, so a mixed shelf stays on one
baseline.

### 4.4 Access badge
Small pill, 12px label, icon + text. Exactly one per card — the only colour accent in the text
column.

| Tier | Fill | Text | Icon |
|---|---|---|---|
| Open Access | Mint Dark `#00786E` | white | open padlock |
| Subscription | `#D4E3FF` | Indigo `#002244` | closed padlock |
| Elite | `#2852C7` | white | crown |

> `Elite` is **provisional** — the T&F palette has no purple and the real value is an open
> decision. Render it as shown, but do not treat it as final.

### 4.5 Hero banner
Top of Catalogue Home. **Full-bleed to the screen edges**, rounded bottom corners only (16px).
Indigo → Ultramarine diagonal gradient. Inside, left-ranged with generous padding:
a small translucent stat pill (Aleo Light, e.g. *"Over 140,000 peer-reviewed titles"*), a large
Aleo Bold headline, one line of body copy, and a single white pill button with Ultramarine text.
Optionally one very faint white circular shape, bottom-right, at ~6% opacity. Nothing else.

### 4.6 App bar
Indigo `#002244`, 56px plus the status bar inset. Status bar glyphs **white**.
- On tab roots: the Taylor & Francis wordmark lockup, white, left-aligned, 32px tall.
- On pushed screens: a thin white back chevron plus a single-line title.
- Right: a translucent white pill (14% opacity) holding a small building icon, the institution
  name, and a check mark.

### 4.7 Tab bar
White, hairline top border, four tabs: **Catalogue, Search, Library, Profile**. Line icon above
a 12px label. Active = Ultramarine icon, label and a short 2px underline. Inactive = Slate.

### 4.8 Bottom sheet
White, 16px top corners, a small grey grab handle, 60–70% screen height, over an Indigo backdrop
at 50%. Used for sign-in, the access gate, filter & sort, and the font picker.

### 4.9 States
- **Loading — skeletons only, never spinners.** Cloud `#E9E9EC` bars at exactly the dimensions of
  the content they replace, so nothing shifts when data lands.
- **Empty** — a centred thin line icon, a short bold line, one sentence of guidance, and one
  outlined pill button.
- **Error** — a short plain sentence and a "Retry" button. Never a code or a stack trace.
- **Offline** — a Carbon `#283857` bar pinned to the top with white text, *"You're offline."*

---

## 5. Screens

Ordered by priority. Each screen keeps the app bar (4.6) and tab bar (4.7) unless noted.

### 01 — Catalogue Home
Vertical scroll on a plain white page.
1. Full-bleed hero (4.5).
2. **Featured shelf** — section header with a "See all" link, then a horizontal carousel of book
   tiles (4.2) ~176px wide. The row **bleeds past the screen padding** so the next tile is half
   visible at the right edge.
3. **Two or three further shelves** — section header, then vertical book cards (4.1).

*States: loaded, loading (hero skeleton + 3 card skeletons), empty, error, offline banner.*

### 02 — Shelf listing
Pushed screen, title in the app bar. An outlined "Filter & Sort" pill top-left, then a
**2-column grid of book tiles** (4.2) with 16px gutters. Foot of the list: a small centred
"Showing 24 of 312" line and a "Load more" text button.

### 03 — Item Detail — Book
No tab bar. Scrolling.
1. A soft Indigo gradient scrim across the top third, fading out to white.
2. The cover, **centred, large (~180px wide, 2:3)**, floating on the scrim with a strong shadow
   and its spine strip.
3. Left-ranged below: Aleo Bold title, optional subtitle, `By Author, Author` with the names in
   Ultramarine.
4. A row of a format tag and the access badge.
5. A thin rule, then metadata lines each with a small line icon: ISBN, page count, publication
   date and publisher.
6. "About this title" section header, then the description, clamped with a "Read more" link.
7. A **pinned bottom action bar** — white, top hairline, a full-width Ultramarine pill button
   (`Read`, or `Play` for audio) and, where applicable, an outlined `Download` beside it.

### 04 — Search
Fixed top block: a white rounded search field with a leading line magnifier and a trailing
microphone, then a helper line, then a "Filter & Sort" pill. Then, depending on state:
- **Idle** — "Recent searches" with clock-icon rows, then "Recently viewed" as book cards.
- **Results** — a small "1,245 results" line, then a **2-column grid of book tiles**.
- **Empty** — a centred card: line icon, *"No books match 'query'."*, a short bulleted list of
  suggestions, and a "Clear search" outlined pill. Below it, a "Browse instead" group of
  full-width single-line rows in cycled blue tints.
- **Voice** — a full-screen Indigo overlay, a large pulsing concentric white mic ring, live
  transcript text, and Search / Clear / Cancel.

### 05 — Library
Pinned header: Aleo "Library", one line of subtitle, then a **pill-style segmented tab rail**
filling the width — All · Borrowed · Downloads · Bookmarks · Premium. Active pill Ultramarine
with white text; inactive transparent with Slate text. Below, a scrolling list of book cards,
each with a contextual extra line: a due date, "Downloaded", "Access expires: 14 Mar", or a
queue position `#3 of 7` with a thin Saffron progress bar.

### 06 — Institution picker
A page header, a search field, then a prominent **"Current institution" card** — white, with the
institution's emblem on a white circular disc at 64px, the name in Aleo, the country, and a Mint
Dark check with "Active access". Then "Recent institutions" as a clipped group, then "All
institutions" as a long list of rows: 48px emblem, name over two lines, country beneath.

> Emblems frequently fail to load. The fallback is an **initials monogram** — a Cornflower
> Neutral disc with the institution's two initials in Ultramarine, Open Sans Bold. Show both in
> the design.

### 07 — Institution detail
Centred column: large emblem (80px) or monogram, institution name in Aleo, country, an
Ultramarine pill "Select this institution", and a plain text "Back" button.

### 08 — Sign-in sheet
Bottom sheet (4.8) over a dimmed catalogue. Centred: "Sign in" heading, the institution name
with "city · country" beneath, a full-width Ultramarine pill "Sign in through your institution",
and a plain "Cancel" text button.

### 09 — Access gate sheet
Bottom sheet. "Choose how to access" heading, then a small block *"You're trying to access:"*
with the book title and authors, then **two selectable method cards** — each a white bordered
card with a line icon, a bold label and a grey sub-label: *"Through my institution / Sign in via
your university"* and *"Personal account / Sign in with email and password"*. Then a plain
"I'll decide later".

### 10 — Personal account
Page header "Sign in" / "Create an account", a short intro line, then a stacked form of labelled
white text fields with 8px radius and Cloud borders — Email, Password, and Confirm password when
registering. A full-width Ultramarine pill submit button. At the foot, a small centred prompt
with an Ultramarine link to switch mode. Show one field in its **error state**: Coral Dark border
and a short message beneath.

### 11 — Profile
Scrolling white page.
1. An **identity card** — the institution emblem or monogram, the institution name in Aleo,
   "Institutional access", a Mint Dark check with "Active access", and small building-icon lines
   for name and country.
2. A "Change institution" row.
3. Two grouped white cards with chevron rows: **Reader experience** (Reading Preferences,
   Accessibility, Download & Offline) and **Preferences & system** (Notifications, Privacy &
   Security, About T&F Reader).
4. A Coral-tint `#FBE9EE` card with a Coral Dark log-out icon and "Sign out".

### 12 — Reader (EPUB)
Full-bleed page, **no tab bar**. A slim top toolbar with four thin line icons (search, bookmarks,
accessibility, menu) on white with a hairline bottom border. The book page fills everything
below, in the reader's own theme (default: near-black text on white, generous margins). A slim
bottom bar: `‹ Prev`, a centred `Contents (24)` button, and `Next ›`. For PDFs, a centred
`3 / 400` page indicator that becomes a small input when tapped.

> This screen is the one place brand chrome recedes. The reading surface stays neutral; only the
> toolbars carry the palette.

> **The two colours in this brief that are not brand tokens live here.** The reader's *content*
> themes — Sepia `#F4ECD8` and Dark `#121212` — are a separate system from the app chrome,
> defined in `src/features/personalization/readerAppearance.ts`. They are reading surfaces chosen
> for legibility, not brand colours, and they appear only inside the book and as swatches in the
> theme picker (screen 14). They must never leak into app chrome.

### 13 — Audio player
White page. The book cover **large and centred** (~200px, 2:3, strong shadow, spine). The title
in Aleo Bold beneath, then the author. A scrubber: elapsed time, a thin Ultramarine track with a
round knob, remaining time. A transport row: `−15s`, a large Ultramarine circular play/pause
button, `+15s`. Below, a row of five small speed pills — 0.75× 1× 1.25× 1.5× 2× — with the active
one filled Ultramarine.

### 14 — Reading preferences
Page header plus a one-line caveat. Then four white grouped cards: **Theme** (a segmented control
showing Light / Sepia / Dark swatches), **Font** (an "Aa" icon and a dropdown trigger),
**Layout** (two segmented controls), **Typography** ("Tt" icon, a segmented text-size control and
three labelled sliders with numeric readouts). At the foot, a Coral-tint "Restore defaults" card.

---

## 6. Do not generate

The list that keeps the output from drifting into generic SaaS. Paste it with any prompt that
comes back looking templated.

**Colour**
- No purple, violet, teal, orange, pink, or warm grey. No hue outside §2.
- No pure-black text. Carbon `#283857` is the darkest text.
- No full-page colour tints. Every page is white; `#EBF0FF` is for small fills only.
- No neon, no glow, no saturated gradients outside the blue ramp.

**Type**
- No Inter, Poppins, Montserrat, Roboto, Lato, Nunito, or system fonts.
- No weights 500 or 600.
- No all-caps body copy, no letter-spaced tracking-out, no drop caps, no gradient text.
- Aleo never used for buttons, labels, tabs or navigation.

**Form**
- No glassmorphism, frosted blur, or neumorphism.
- No card boxes, borders, fills or shadows around books in a list. Books sit on bare white.
- No hairline dividers between list items. Whitespace only.
- No fully-rounded (pill-shaped) cards. Where a card genuinely exists (settings groups), 8px.
- No heavy or coloured drop shadows. Shadows are soft, neutral and subtle.
- No 3D book mockups, perspective covers, page-curl effects or angled stacks. Covers are flat
  rectangles at 2:3.
- No floating action button. No hamburger menu — navigation is the four-tab bar.
- No dark mode.

**Content**
- No prices, currency, "Buy", "Add to cart", or subscription upsells. Access is institutional.
- No star ratings, review counts, "trending", "popular", or follower counts.
- No avatars of people, no social features, no comments, no sharing.
- No fake logos for the institutions — use a monogram disc.
- No lorem ipsum. Use plausible academic titles, real-sounding author names, and genuine
  scholarly publishers (Routledge, CRC Press, Taylor & Francis).

**Iconography**
- No emoji. No filled or duotone icons. No illustration spots or mascots.

---

## 7. Sample content for mockups

Use these so screens read as a real academic catalogue:

**Titles** — *Climate Change and the Coastal City* · *Postcolonial Literatures in Translation* ·
*Quantitative Methods for Health Research* · *The Political Economy of Migration* ·
*Foundations of Structural Geology* · *Digital Ethics and Machine Learning Governance* ·
*Urban Water Systems and Resilience* · *Narrative Theory After Modernism*

**Authors** — Jane Okonkwo · Ravi Menon · Elena Castellanos · Tomás Lindqvist · Priya Raghavan ·
Daniel Achebe-Moore

**Publishers** — Routledge · CRC Press · Taylor & Francis · Psychology Press · Focal Press

**Institutions** — University of Manchester · Delft University of Technology ·
National University of Singapore · Universidade de São Paulo

**Shelf names** — Featured this month · New in Environmental Science · Open Access highlights ·
Most borrowed at your institution

**Hero copy** — stat pill *"Over 140,000 peer-reviewed titles"*, headline *"The Scholarly
Archive"*, body *"Books, journals and audiobooks from Taylor & Francis, wherever you research."*,
button *"Explore all titles"*.

---

## 8. Notes for whoever implements the result

- The palette, type scale, spacing and radii above map 1:1 onto `src/theme/tokens.ts`. This
  redesign introduces **no new colour and no new font**.
- `docs/CONVENTIONS.md` §5 forbids raw hex and bare numbers in a `StyleSheet` — everything must
  resolve to a token.
- `ContentCard` must keep its slot-based contract: `badge` and `action` stay `ReactNode`s, and it
  must never compute access itself (Design Specification §5.1).
- Skeletons must keep matching final dimensions exactly. Growing the cover from 96px to 112px
  means growing every skeleton bar with it.
- Two values in this brief are **provisional and owned by the team, not by this document**: the
  Elite badge colour, and whether page titles are Bold or Regular. Both are marked PENDING in
  the Design Specification.

> **One more separate-system note.** The reader's *body* font picker (screen 14) offers
> Merriweather, Lora, Roboto, Montserrat, Poppins, Inter and OpenDyslexic — bundled `.ttf` files
> injected into the reading WebView (`src/features/personalization/fontFaceLoader.ts`). Inter
> appears there and that is fine: the ban on Inter applies to **app chrome**, not to a reader's
> choice of typeface for the book they are reading. Do not offer Open Sans or Aleo in that list.
