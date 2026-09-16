# CLAUDE.md — standing instructions for this repo

TF Reader mobile (Expo / React Native), team t4targaryen, CAP-7 Reader & Offline.
Read `README.md` (repo-wide) and `T4_Readme.md` (CAP-7 specifics) for context. This file is only
the rules that must survive across sessions.

## Reader ⇄ WebView bridge — read the doc before touching it

**`src/features/reader/WEBVIEW_BRIDGE.md` is the source of truth for the reader bridge.**

**The WebView half is typechecked TypeScript, as of 2026-08-18.** It imports `ReaderMessage` and
`ReaderCommand` from `readerBridge.ts`, so the two halves are one contract with two consumers rather
than two hand-synced descriptions of one protocol. `npm run typecheck` is the drift guard now — the
tests that used to read the templates as text are gone, and deleting them was the point.

| File                                                    | Holds                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `webview/src/bridge.ts`                                 | `post`/`fail`/`showFallback`/`base64ToArrayBuffer`, `TFReaderApi`   |
| `webview/src/epub.entry.ts`                             | epub.js renderer, `openEpub`                                        |
| `webview/src/pdf.entry.ts`                              | pdf.js renderer, `openPdf`, the worker wiring                       |
| `webview/src/readerMetrics.ts`                          | typography arithmetic + the stylesheet — **pure, unit-tested**      |
| `webview/src/epubOutline.ts`, `pdfOutline.ts`            | navigation/outline → `toc`, page + scale maths — **pure, unit-tested** |
| `webview/src/highlightSeam.ts`, `pdfHighlightSeam.ts`   | the ONLY callers of `rendition.annotations` / the PDF text+box layers |
| `webview/src/epubViewGeometry.ts`                       | the ONLY caller of epub.js's `View.expand()` — makes a re-styled chapter re-measure |
| `webview/src/highlightNaming.ts`, `highlightPaint.ts`, `epubCfiRange.ts`, `epubLayoutSignature.ts`, `pdfTextRange.ts`, `touchGesture.ts`, `selectionTheme.ts` | owner naming, paint diffing, CFI range join/split, which appearance changes move a glyph, PDF offset maths, swipe/long-press thresholds, `::selection` colour — **pure, unit-tested** |
| `webview/reader-{epub,pdf}.template.html`               | **HTML and CSS only** — the DOM each entry queries                  |

`buildReaderHtml.ts` compiles each entry with **esbuild** (one IIFE per format) and inlines it beside
the libraries. `esbuild` is pinned **exactly** in `package.json` on purpose: CI regenerates both
artifacts and `git diff --exit-code`s them, so output determinism is load-bearing. A flapping diff
means the version drifted — do not "fix" it by loosening the CI check.

**Both reading gestures are recognised INSIDE the WebView** — long-press (select text / press a
highlight) and the directional drag that turns the page. There is no RN gesture overlay over the
book any more, and there must not be one again: an overlay is the topmost hit-test target for every
touch in the viewer, so the document beneath it can never receive a `touchstart`, and text selection
(the first half of highlighting) stops working with nothing to explain why. See
`webview/src/touchGesture.ts`.

**Keep DOM-reading code in the entries and everything else in the pure modules.** That split is what
makes the outline flatteners, the line grid and the page/scale arithmetic testable by *calling* them.
If you are about to write a loop with a `+1` in it inside an entry, it belongs next door.

**Read the doc before** adding or changing any `ReaderMessage` type, any `READER_COMMANDS` entry, any
`window.TFReader` method, or anything in a template. **Then update it.** In the same change:

1. Change `readerBridge.ts` and let the compiler find the rest — a new message case or command fails
   to compile in the WebView half until it is handled.
2. Add the case to `parseReaderMessage()`. **`tsc` will not catch this one**: a missing case returns
   `null` and surfaces as `BRIDGE_PARSE_FAILED` at runtime. `parseReaderMessage` is NOT redundant now
   that types are shared — compile-time types do not survive the JSON hop, and the payload is built
   from book content.
3. Run `npm run reader:build-html`. **Both** `assets/reader/reader-epub.html` and `reader-pdf.html`
   are **generated but tracked**, and a change to `bridge.ts` or a shared pure module invalidates
   both.
4. Update the **Current surface** table in `WEBVIEW_BRIDGE.md`.
5. Run it on the simulator for anything that affects rendering. Unit tests cannot see a blank page.

**Format routing does NOT cross this bridge, and must not start.** `ContentFormat` is frozen, so the
host picks between `openEpub` and `openPdf` in typechecked TS and only the command *name* travels.
Each entry declares `TFReaderApi<'openEpub'>` or `TFReaderApi<'openPdf'>`, so defining the wrong one
is a compile error; and a test in `readerBridge.test.ts` fails if a `ContentFormat` literal ever
appears in a command script. Collapsing them into `open(base64, format)` reads tidier and puts a
frozen enum value on the wire.

**The trigger list is history, not a forecast — do not re-run it.** It existed to date the hand-sync
debt, prefs-application called it in, and the conversion happened before that command was written.
`WEBVIEW_BRIDGE.md` keeps the record of how that was decided, because a written expiry date whose
ending nobody records is how the next person re-litigates it.

**Prefs-application is the next task in `reader/`, and it is no longer blocked.** See "The
prefs-application design, as signed off" in `WEBVIEW_BRIDGE.md`: one `applyAppearance(ReaderAppearance)`,
sent **before** `open*`, resolved host-side into a flat primitive-only payload
(`features/personalization/readerAppearance.ts`). Adding it to `CommandArgs` now *requires* both
entries to define it, so the "must be in both halves" trap is enforced rather than remembered. Do not
let the payload split into a second `applyA11y` sibling — one command carries everything the WebView
renders with, for all three claimants (Personalization's typography/theme, Reader's `reduceMotion`,
Accessibility's `announce.pageChanges`).

## Reader accessibility — five rules that are easy to undo by accident

`src/features/reader/READER_ANNOUNCEMENTS.md` is the source of truth for the announcement seam;
`src/features/accessibility/WEBVIEW_A11Y_SPIKE.md` is the device evidence. Five things in the code
look like tidy-ups and are not:

**1. `ReaderWebView`'s container must NOT carry an `accessibilityLabel`.** On Android RN maps it to
`setContentDescription`, and a ViewGroup that is important-for-accessibility with one is a
screen-reader focus LEAF — TalkBack announces the container and never descends into the WebView's
virtual node tree, so no heading, paragraph or link in the book is reachable. This is the
"accessibilityLabel trap" three docs in `src/features/accessibility/` name, using the exact string
`"Book content"` as the example, and it was in this repo for two days. The named stop is a 1x1
`accessible` sibling INSIDE the container instead. Adding a label back to the container makes the
book unreadable to TalkBack with nothing on screen to explain why.

**2. A screen reader forces `flow: 'scrolled-doc'`, and the user is TOLD.** epub.js paginates with a
CSS multi-column strip that Android's WebView cannot compute usable accessibility bounds for (spike
F4/F6: the whole book present in the node tree at `bounds=[0,0][0,0]`). `readerA11yLayout.ts` is the
rule; it is applied in `ReaderScreen`'s `buildAppearanceWithFont`, NOT in Personalization's
`toReaderAppearance` — that function resolves preferences, and screen-reader state is not one.
**Never make this silent.** `ReaderScreen` shows a one-time `Alert` with a "Use pages anyway"
opt-out, and `DevPreferencesMenu` disables and annotates its Flow/Spread rows while it applies. The
opt-out lives in `a11yOverrideChoice.ts` — a module, not component state, because the prefs menu
arrives through `toolbarExtra` and is not `ReaderScreen`'s child.

**3. Nothing announces unconditionally.** Every announcement passes three gates: a previous value
exists, the user's `announce.pageChanges`/`announce.chapterChanges` allows it, and TTS is not
speaking. That last one is not optional — react-native-tts and the screen reader share one output
device and neither ducks, and `useTtsSession`'s `autoContinueChapter` turns pages *while reading*.
`announce()` (`a11yAnnounce.ts`) is the shared transport and is deliberately opinion-free; the rules
and wording are `readerAnnouncements.ts`, which is pure. Search results are **declined**, not
overlooked — `SearchMatchBar.tsx:50-64` carries the argument.

**4. Accessibility's two applied overrides are resolved HOST-SIDE, and that is why both are still
`PaintOnlyKey`.** `highContrast` and `dyslexiaFont` are applied in `ReaderScreen.tsx`'s
`buildAppearanceWithFont`, beside `a11yFlowOverride` — the dyslexia face lands as
`fontFamily`/`customFontUri`, the contrast pair as `fg`/`bg`/`link`. Both target keys are ALREADY
`GeometryKey`, so a toggle moves the layout signature and every painted highlight re-measures for
free, with no shell change and no new `ReaderAppearance` field. Wiring either one into
`appearanceCssOptions()` instead would oblige promoting its own key in `epubLayoutSignature.ts` and
would then re-measure twice for one change. **`dyslexiaFont` is gated on `format === 'EPUB'` at that
same seam** — the preference is per user, not per book, so a `true` set on an EPUB still arrives on a
PDF's payload, and pdf.js has no text CSS layer to override.
`loadDyslexiaFontFaceSrc` **can reject** where `loadFontFaceSrc` cannot, so it carries its own
try/catch: an escaping reject would abort `buildAppearanceWithFont` inside `applyAppearanceWith`'s
single catch and send the WebView NO appearance at all — losing theme, text size, margins, flow and
both announce gates for the sake of a font. `WEBVIEW_BRIDGE.md` has the full account, including why
`reduceMotion` is now consumed by `epub.entry.ts` only (wired in 2026-09-08, for TTS's teleprompter
repositioning) and stays unconsumed, deliberately, by `pdf.entry.ts`.

**5. `ReaderWebView`'s container must not carry `accessibilityActions`/`accessibilityRole` either —
same mechanism as rule #1, a different prop.** RN's Android accessibility delegate synthesizes a
`contentDescription` on any view that has `accessibilityActions`, `accessibilityState`,
`accessibilityLabelledBy`, or `accessibilityRole` set and no existing text/description, by
concatenating descendant text/descriptions. A ViewGroup with a synthesized `contentDescription` is
the identical screen-reader focus LEAF rule #1 already fixed for a literal `accessibilityLabel`
prop — TalkBack announces it and never descends into the WebView's tree. This surfaced when
`TALKBACK_GESTURE_FIX_PROPOSAL.md`'s page-turn action (a native `accessibilityActions`/
`onAccessibilityAction` pair, so TalkBack can turn pages without needing the still-open WebView
accessibility-bridge defect fixed) was originally sketched onto the container. The action pair lives
on `reader-webview-a11y-pageturn`, a dedicated 1x1 sibling — parallel to the existing
`reader-webview-a11y-stop` named stop, not layered onto it (that node serves a different purpose).

**A painted highlight's RECTS live for one layout, and epub.js will not re-measure them for you.**
marks-pane re-measures only inside `View.reframe()`, which a stylesheet change never reaches — the
chapter body is pinned to a fixed size in paginated flow, so more text means more columns and no
observed box changes; and even when it does fire, the reframe is gated on the strip's *rounded* width
moving. So `epub.entry.ts` asks for the re-measure itself (`scheduleGeometryRefresh` →
`forceReflow` + `repaintLiveAnnotations`), and `epubLayoutSignature.ts` decides when. That module is
exhaustive over `ReaderAppearance` by a compile-time canary: **adding a typography field there fails
to compile until it is classified as geometry or paint-only.** Classifying a new field as paint-only
when the shell renders with it is how the drift comes back, and no test can see it —
`HIGHLIGHT_LAYERS.md` §3a is the full account.

## Generated and tracked artifacts

| Artifact | Generated by | CI-checked? |
| -------- | ------------ | ----------- |
| `assets/reader/reader-epub.html` | `npm run reader:build-html` | **yes** |
| `assets/reader/reader-pdf.html` | `npm run reader:build-html` | **yes** |
| `assets/reader/sample-plaintext.pdf` | `npm run reader:build-sample-pdf` | **yes** |
| `assets/reader/sample-plaintext.epub` | `npm run reader:build-sample` | no — see below |
| `assets/reader/sample-search-index.json` | `npm run reader:build-sample-index` | no — see below |

Never hand-edit any of them; regenerate and commit the result.

The two HTML files come from one generator and share `webview/src/bridge.ts` (plus the pure modules),
so **one shared-module edit invalidates both** — rebuild and commit both, or CI's "Reader HTML is
freshly generated" step fails on whichever you forgot. Forgetting is a red build, not a silent stale
ship.

`sample-plaintext.pdf` is checked the same way ("Sample PDF is freshly generated"), because unlike
the EPUB it *is* byte-reproducible: `generateSamplePdf.ts` emits no `/CreationDate`, `/ModDate` or
`/ID`, and asserts their absence itself. **Do not add a date to it** — that breaks the CI check on
every run, and the honest fix would be removing the check rather than loosening it.

`sample-plaintext.epub` is **not** covered — JSZip stamps each entry with the generation time, so
it is not byte-reproducible and the same check would fail every run. That one is still on you.

`sample-search-index.json` is not covered either, but for a different reason: it *is* byte-
reproducible (no timestamps), so a freshness check would work. It is left out to keep CI's scope
unchanged for a file that is temporary scaffolding — see the deletion table below. Regenerate it if
the sample EPUB changes, or its CFIs will point into a book that no longer matches.

## Frozen contracts

`src/shared/contracts/` is the Week-1 freeze — the interface between seven capabilities owned by
five people. `__typecheck__.ts` is the canary. **If the canary goes red, a freeze broke: find out
why, don't "fix" the canary.** It is in `.prettierignore` deliberately (`@ts-expect-error` is
line-positional). Import via the `index.ts` barrel, never deep paths.

Relaxing a frozen field to match a **published** external spec is not a freeze break — it is the
freeze doing its job, because the frozen type was wrong about the wire. Pin the new shape in
`__typecheck__.ts` in the same change. Removing or renaming an exported type **is** a break, and
that is a Contracts Gate conversation.

## The external API contracts — read your capability's notes before touching wire code

`src/shared/contracts/` is the *internal* freeze. The **external** contracts are team wokay's and
team flambeau's published OpenAPI specs, and this app diverges from them in ways that are tracked,
not accidental. Findings have stable IDs (`A1`, `B4`, `C7`) — quote the ID rather than restating the
problem.

| Read this | Before touching | Owner |
| --------------------------------------------------------- | ---------------------------------------- | --------- |
| `src/shared/contracts/CONTRACT_ALIGNMENT.md` | anything in `src/shared/contracts/` | Ahana |
| `src/features/download/API_CONTRACT_NOTES.md` | any HTTP call, `DownloadError`, the open path | Abhinav |
| `src/features/encryption/API_CONTRACT_NOTES.md` | licence/key logic, `deviceKeypair.ts` | Abhinav |
| `src/features/sync/API_CONTRACT_NOTES.md` | `syncApi.ts` URLs, `syncConfig.ts`, a new entity | Karthik |
| `src/features/search/API_CONTRACT_NOTES.md` | `queryIndex.ts`, anything catalogue-shaped | Vaishnavi |
| `src/features/personalization/API_CONTRACT_NOTES.md` | prefs shapes that sync | Vaishnavi |
| `src/features/accessibility/API_CONTRACT_NOTES.md` | prefs scope, the TTS seam | Hruthik |

`CONTRACT_ALIGNMENT.md` is the ledger — status of every finding, and who has to close it. The
per-capability files are the detail: what breaks, what to change, what is blocked on another team's
answer, and which things look wrong but are correct and must not be "fixed".
`src/shared/contracts/API_CONTRACT_REVIEW_CONTEXT.md` is the full evidence base (every quote and
mapping table); it is committed rather than linked because three tracked files used to cite a
`flambeau-contract-comparison.md` that has never existed on any branch. **If you add a contract
citation, cite a path that resolves.**

**When you close a finding, strike it in both the capability file and the ledger, in the same
change.** A ledger that lags the code is worse than no ledger.

Two items are blocking and are questions for other teams, not code: **`C6`** (neither contract says
how the app receives its token after the SAML browser round trip — blocks all auth) and **`C7`**
(the `keyFingerprint` digest recipe is a guess, and the check now fails closed, so a wrong guess
rejects every encrypted download).

## Ownership — flag before editing another team's files

| Area                                                    | Owner        |
| ------------------------------------------------------- | ------------ |
| `src/features/reader/`                                  | Ahana        |
| `src/features/download/`, `src/features/encryption/`    | Abhinav      |
| `src/features/sync/`                                    | Karthik      |
| `src/features/personalization/`, `src/features/search/` (in-book search only) | Vaishnavi    |
| `src/features/accessibility/`                           | Hruthik      |
| `src/shared/`, `samples/`                               | Ahana (lead) |

`src/features/search/` is **in-book full-text** search over a decrypted per-book index — it touches
neither external contract. **Catalogue/discovery search** (wokay's OPDS feeds, institution picker,
`items:batch`) is a *different* capability that shares the word "search" and is currently
**unowned** — finding `C3` in `CONTRACT_ALIGNMENT.md`. This row does not cover it; do not assume the
OPDS client falls to Vaishnavi because it says "search."

Editing outside Reader needs the owner looped in. Prefer a test that documents the defect plus a
local workaround, and say clearly that the real fix needs sign-off.

The same boundary applies to **tooling strictness**, not just code. Type-aware ESLint
(`no-floating-promises`, `no-misused-promises`, `await-thenable`) is enabled for
`src/features/reader/**` only — see the scoped block at the bottom of `eslint.config.js`. It is
scoped because turning it on repo-wide would hand every other capability a pile of lint failures
on Reader's schedule. **To opt your directory in, add it to that block's `files` list** — the rule
set and the `projectService` wiring are already there, so it is a one-line change. Do not enable
it for someone else's directory on their behalf.

`__mocks__/react-native-quick-crypto.js` gained `randomBytes` on 2026-08-18 so `ensureSeeded()` could
be exercised under Jest, and `createCipheriv`/`createDecipheriv` the same day for `aesGcm.ts`'s swap
onto this module. Test-only, additive, and one-line passthroughs to Node's `crypto` in keeping with
that file's design — but it is a shared mock, so it is recorded here rather than only in git. Both
halves arrived on separate branches and collided on rebase; the resolution keeps every passthrough
and names both consumers, because the next such edit will collide the same way.

`__mocks__/expo-file-system.js` gained `Directory.list()` on 2026-08-25, for
`audioAssetResolver.ts`'s scratch-directory sweep. Same rules as the mock above and the same reason
for recording it here: it is shared (`contentStore.ts` is its other consumer). It mirrors the real
`Directory.list()` including the part that matters — it **throws** when the directory does not
exist, rather than returning `[]`, so a caller that stops guarding on `.exists` fails in the test
run instead of silently passing.

### Known open items — Abhinav's call

This list used to have four, then two. **The stale keychain-cached BEK is fixed:** `store()` now
clears the cached BEK when the incoming `wrappedBek` differs from the persisted one
(`invalidateStaleCachedKeyIfRotated`, `contentStore.ts:206`), and
`contentStore.edgecases.test.ts` pins the fix rather than the defect. `devContentSeed.ts`'s
`destroy()`-before-`store()` stays, but for the other things destroy() clears, not for this.

The one below is a memory defect found from Reader's side. It is **not** the whole list of open
items in Download/Encryption — the contract-driven ones live in those directories'
`API_CONTRACT_NOTES.md` (see the table above).

**The resident-ciphertext-after-`close()` item is FIXED**, by Abhinav on 2026-08-18: `close()` now
does `packageCache.delete(bookId)`, and `decryptBook()` additionally empties `pkg.content` for
non-Elite packages once the plaintext exists (two of the "roughly six" copies item 1 counts). The
cold-read trade-off it names below was taken deliberately and is documented at both call sites. The
cost lands in Reader — `prepareBook`'s `getFormat` is now only cheap WARM, because a cold
`resolvePackage` reads the whole ciphertext with a synchronous `bytesSync()`; `readerAssets.ts`
records that where the call is made.

**The `close()`-is-TERMINAL-for-Elite item is FIXED**, by Abhinav on 2026-08-26, and it stopped
being hypothetical before it was closed. That entry said the defect was invisible "because nothing
ships Elite content" — that ceased to be true when `openBook()` began forcing `canPersist: false`
on every STREAMED book, which makes every streamed book Elite. The symptom in the app was a
backend audiobook (`dev-sample-audio-encrypted`) failing `DECRYPTION_FAILED` on re-entry, since
`audioAssetResolver` calls `closeBook()` after every resolve.

`close()` now exempts Elite from the `packageCache` delete — the guard that entry proposed — so it
is REVERSIBLE for every tier and `destroy()` is the only terminal one, as `content-provider.ts`
specifies. No RAM is given up: `decryptBook()` already skips its `pkg.content` release for Elite
for the same reason, so there was never a second copy to reclaim, and the plaintext is still zeroed.
`contentStore.test.ts` now pins the whole lifecycle per tier, and the `EDGE:` block in
`contentStore.edgecases.test.ts` that pinned the defect is gone, per its own instruction.

**A second defect travelled with it, in Reader, and is fixed in the same change.** `contentStore`
sessions are keyed by bookId with **no reference counting** — one session per book, not one per
caller — so two concurrent `resolveAudioAssetUri()` calls tore each other down: the first to finish
called `closeBook()`, which both dropped the package (the `DECRYPTION_FAILED` above) *and* zeroed
the shared plaintext buffer the second was about to write, silently producing a scratch file of
pure zeros. `AudioPlayerScreen`'s load effect is the caller that overlaps — its `cancelled` flag
suppresses a stale `setUri` but does not abort the in-flight promise, so leaving the screen
mid-load and re-entering leaves two acquires running against one session.
`audioAssetResolver.ts` now dedupes in-flight acquires per bookId (`inFlight`), cleared on settle
so it stays a dedupe and not a URI cache. **If you add another caller of a `contentStore` session,
assume no refcounting and do not close a book someone else may be reading.**

**1. Peak memory tracks the NUMBER of full-size copies, not the cost of making them.** The headline
holds and is now proven twice over: **both** codec swaps have landed, time fell by ~30x, and the
peak did not move. Measured on a real 20 MB EPUB (iPhone 17 Pro simulator, dev build):

| | 2026-08-13, before codec swaps | 2026-08-17, both landed | Verdict |
| --- | --- | --- | --- |
| App RSS peak | 609 MB | **631 MB — still unchanged** | 🔴 the real problem |
| WebContent RSS peak | 389 MB | 385 MB | 🟢 |
| `encode` (Reader's hop) | 1820 ms | 21 ms | ✅ fixed |
| `decrypt` (`getBook`) | 4882 ms | **104–118 ms** | ✅ fixed by Abhinav, `47bc4ce` |
| `getBookBase64` TOTAL | ~6.7 s | **149–310 ms** | ✅ |

Abhinav's `47bc4ce` swapped `aesGcm.ts` to `react-native-quick-base64` directly — better than this
file's earlier proposal to route `base64.ts` through it, because `base64.ts` stays the portable,
no-native-dependency fallback its own header promises. **Time is no longer the lever; nothing here
is waiting on a codec.**

What did NOT change is the point: opening a book still materialises the payload at full size
roughly **six** times, so a ~630 MB peak survives making every one of those copies ~30x faster. Only
*removing* copies moves the peak. That is now the sole remaining lever, and it is a design change
(streaming, or a bytes-in/bytes-out native API), not an optimisation.

**Copy removal has since STARTED, and the peak above predates it — do not quote the 631 MB as
current.** Abhinav's 2026-08-18 work removes two of those full-size residents for non-Elite books
(`decryptBook` empties `pkg.content` once the plaintext exists; `close()` drops the `packageCache`
entry). By this item's own logic that should move the peak, which makes it the first change here that
is worth re-measuring rather than reasoning about — and it is **unmeasured**: the numbers in the
table were taken before it landed. `READER_MEASUREMENTS.md` has the procedure.

Caveat that must travel with these numbers: **simulator, dev build, and the simulator has no
jetsam.** ~1.0 GB combined would be a likely foreground kill on a 2 GB device. Real-device
confirmation is still outstanding. Also still unmeasured: the post-`closeBook` drop.
`src/navigation/RootNavigator.tsx` has now landed (2026-08-23), and navigating BookList -> Reader ->
back to BookList genuinely unmounts `ReaderScreen` (`ReaderRouteScreen.tsx`'s own instance, not a
kept-alive one), so this measurement is no longer blocked — it just hasn't been taken yet.

**Confirmed for PDF on 2026-08-18, and it makes this item's headline stronger rather than weaker.**
The app-side cost is **8.66 MB of peak per MB of book, identical to three significant figures for
both formats** — which is exactly what "peak tracks the number of copies, and the copies are
Encryption's" predicts, now measured rather than argued. The renderers differ only inside the
WebView (7.30×/MB for pdf.js against 11.21×/MB for epub.js), so **no renderer choice moves this
item**; only removing copies does. Full tables, procedure and the four-process RSS correction —
app+WebContent undercounts by ~263 MB, because `WebKit.GPU` and `WebKit.Networking` were never
counted — are in `src/features/reader/READER_MEASUREMENTS.md`. Read that before re-measuring.

## Temporary scaffolding

**`src/features/reader/devContentSeed.ts` is DELETED**, on 2026-09-07 (commit `aa7eeb1`), together
with `devFixturePath.test.ts` and `devSearchIndex.test.ts`, and the `ensureSeeded()` call is gone
from `readerAssets.ts`. Read the rest of this section as a record of what happened, not a to-do
list — several items below did NOT go the way this section originally predicted.

The actual unblock was not "a real library screen lands" — `BookListScreen.tsx` is still a
hardcoded list of known ids, not a query against a real catalogue/download-listing API, so that
half of the original blocker still stands. What actually unblocked the file's deletion: the backend
now seeds the same fixture ids directly — `dev-sample-epub`, `dev-sample-pdf`, `dev-fixture-epub`,
`dev-fixture-pdf` all exist in `tf_reader_backend_temp`'s `seed/demo-dataset.json` — so every row in
`BookListScreen` now acquires through `openBook()` like the audiobook row always did, and there was
nothing left for local seeding to do. `BookListScreen.tsx` now declares those four bookId constants
itself instead of importing them from the deleted file. **Do not read "the file is gone" as "the
screen is done" — they turned out to be separable, and only the file went.**

**`assets/reader/sample-plaintext.epub` is NOT Reader's to delete alone.**
`src/features/search/extractor.ts` hard-codes its path and `search.test.ts` depends on it. Still
needs Search looped in before it goes.

**`assets/reader/sample-plaintext.pdf` joined it as a permanent shared fixture — this section used
to say the opposite.** It used to be scoped to `devContentSeed.ts`'s PDF branch, with "nothing else
consumes this one, so it needs nobody looped in." That stopped being true once
`src/features/search/extractor.ts` and `searchPdf.test.ts` started reading the generated file
directly. Its generator (`generateSamplePdf.ts`) and the "Sample PDF is freshly generated" CI step
stay for the same reason `generateSampleEpub.ts`'s do: both are now permanent generators for
permanent fixtures. The one item from the old three-item table that really did go: `DEV_FORMAT` /
`EXPO_PUBLIC_READER_FORMAT` and the PDF branch inside `devContentSeed.ts` — gone with the whole file.

**The dev search index split down the middle — half permanent, half deleted.**
`src/features/reader/scripts/buildSampleSearchIndex.ts` used to generate one index per format so
on-device search had something to find before a real index shipped (`devContentSeed.ts` attached
both to the seeded books). Now:

- `assets/reader/sample-search-index.json` (EPUB) survived by picking up a real consumer:
  `src/features/reader/searchCfiAnchoring.test.ts` reads it directly to pin CFI-anchoring against
  real postings. It, and the (now EPUB-only) script that generates it, are permanent — not
  scaffolding to delete with `devContentSeed.ts`.
- `assets/reader/sample-pdf-search-index.json` (PDF) had no such consumer — its only reader was
  `devContentSeed.ts`'s index attachment — so it and the PDF target inside
  `buildSampleSearchIndex.ts` were deleted on 2026-09-07 alongside the file above. Search's PDF
  extractor is proven directly by `searchPdf.test.ts` and never needed this fixture.
- `devSearchIndex.test.ts` (which guarded the two JSON files against the attachments) is deleted
  along with `devContentSeed.ts`.

`queryBookIndex` still throws when an index's `bookId` doesn't match the book requested — that is
why the EPUB and PDF indexes were never interchangeable while both existed. That reasoning is now
historical (nothing attaches either index to a book at runtime any more; the surviving EPUB one is
read directly by a test, not through `queryBookIndex`), kept here so the next person doesn't wonder
why a PDF target ever existed in a script that only builds one now.

`SearchPanel.tsx`, `useBookSearch.ts` and the search wiring in `ReaderScreen.tsx` never depended on
any of this — the UI does not know these fixtures exist, and on-device searches for a book with no
shipped index still correctly return `[]`.

**`EXPO_PUBLIC_READER_FIXTURE_EPUB`/`_PDF`/`_PATH` and `EXPO_PUBLIC_READER_FORMAT` are DEAD CODE, not
deleted code — this is a gap, not a decision someone made.** `devContentSeed.ts` was the only reader
of these env vars, used to push a large book from `samples/fixtures/` (gitignored, never committed)
straight into the container for measurement runs, one path per format. Deleting the file without
replacing that reader means nothing in the app reads them any more, but
`src/features/reader/READER_MEASUREMENTS.md`'s documented re-measurement procedure still tells you
to set them. **That procedure cannot currently be re-run as written.** Fix by wiring a replacement
reader for these env vars, or by rewriting the procedure — this file doesn't pick one, but leaving
both stale is the wrong answer, and it's Ahana's call.

**The four `DEV_FIXTURES` rows in `BookListScreen.tsx` are NOT going away with the rest of this
scaffolding.** `DEV_FIXTURE_EPUB_BOOK_ID`/`DEV_FIXTURE_PDF_BOOK_ID` (the "Big EPUB"/"Big PDF" rows)
used to be pushed in locally via the env vars above; they are now real backend catalogue ids, same
status as `dev-sample-epub`/`dev-sample-pdf`, and stay in `BookListScreen` for as long as that
screen itself does. Whatever is left in `samples/fixtures/` is inert until something is built to
read it again — it is not tied to a specific deletion date any more.

**The "Big" vs. bundled distinction this section used to draw was never about local push vs.
bundled asset — that part is unchanged; only how the large books are reached changed.** The
original intent — the bundled `EPUB`/`PDF` rows retiring once every feature has been exercised on
the real, large books — is still pending. Retiring the bundled pair, and retiring `BookListScreen`
itself, both still wait on the same thing this section named from the start: a real
catalogue/download-listing screen, which does not exist yet. Landing the real backend fixture ids
did not do either — it only removed the need for local seeding underneath the rows that already
existed.

`READER_MEASUREMENTS.md` is not on any deletion list — it records numbers and a procedure that
outlives any fixture. Right now, per the note above, that procedure is broken, not just documented;
that is a gap to close, not evidence the file should go. Neither is `readerTiming.ts` — the probes
are permanent and off by default.

`reader-pdf.template.html`, `pdfjs-dist` and the `openPdf` command remain permanent, as before —
unaffected by any of this.

`EXPO_PUBLIC_READER_FORMAT=PDF` is how you reach the pdf.js path on a device: it flips
`DEV_SAMPLE_BOOK_ID` to a distinct id and seeds the PDF fixture with `format: 'PDF'`, and everything
downstream routes off the stored format. A distinct id is load-bearing, not cosmetic —
`ensureSeeded()` short-circuits on `isAvailableOffline()`, so a shared id would serve whichever book
was stored first and `getFormat()` would report the wrong format for it.

### `testReaderTextProvider.ts` — stood in for the real TTS text provider (renamed from `fakeReaderTextProvider.ts`, 2026-09-09)

**`src/features/reader/tts/fakeReaderTextProvider.ts` is DELETED**, on 2026-09-09, together with
its test — Accessibility (Hruthik) already had its own forked, permanent copy (renamed the same
day to `src/features/accessibility/tts/testSupport/testReaderTextProvider.ts`, dropping "Fake" from
every identifier and the filename — "fake" was confusable with a mocking-library fake rather than
what this is: a deterministic, hand-written test double) since 2026-08-28, and by the time of
deletion nothing outside `reader/tts/` still imported Reader's original. Read the rest of this
section as a record of what happened, not a to-do list.

It served canned sentences with **synthetic CFIs that resolve against no book**, so Accessibility
could build a TTS session before the real provider existed. `src/features/reader/tts/readerTextProvider.ts`
is **not** scaffolding and was never on the deletion list — it is the permanent, agreed contract and
it stays.

The deleted test file's cases were ported into the fork's test file rather than dropped — every
case pins a property of the seam, not of the test double, so each is a checklist the real provider
(and the fork, now the sole surviving copy) must keep satisfying. Four cases (`setSpokenWordRange`/
`spokenWordRanges`: call-order, independence from the sentence log, teardown, silent-accept of an
unresolvable range) were missing from the fork and were added as part of this deletion, not left as
a gap.

`src/features/reader/TTS_PROVIDER.md` is the source of truth for this seam — the decisions, the
ownership boundary, the sequencing, and the open items. Read it before changing
`readerTextProvider.ts`, and update it in the same change.

## Reading-position resume — one store, all three formats, no in-memory cache

Every format's resume is durable and synced through `progressStore.savePosition()`/`currentLocator()`
(Sync's side) — there is no session-only cache layered in front of it for any format. An earlier
version of `src/navigation/ReaderRouteScreen.tsx` kept one (`sessionProgress.ts`, an in-memory
`Map<BookId, ReaderPosition>`) as a same-app-run fast path, on the reasoning that `progressStore` was
only needed for a cold start or a different device. That reasoning had a real hole: the cache had no
way to learn about a position written elsewhere while THIS book merely sat backgrounded — not
relaunched — on this device, so a stale in-memory value could outrank the genuinely current row in
`progressStore` for the rest of that app run. It was deleted for that reason, not just for symmetry
with AUDIO (which never had one, for lack of a cheap synchronous source in the first place).

`ReaderRouteScreen.tsx` now always awaits `progressStore.currentLocator()` before mounting
`ReaderScreen` (behind a loading gate, same shape as `AudioPlayerRouteScreen.tsx`), converting via
`readerProgressStore.ts`'s pure `Locator ⇄ ReaderTarget` functions, unless a caller supplies an
explicit `initialTarget` (e.g. a tapped bookmark), which skips the read entirely. Every `relocated`
writes through to `progressStore` too — throttled, with an unthrottled flush on unmount and on app
backgrounding. `AudioPlayerRouteScreen.tsx` follows the identical shape for AUDIO.

**Both resolve effects also await `syncEngine.run()` before reading `currentLocator()` — a new,
deliberate call from Reader's own files into Sync's already-public API, not a change to
`src/features/sync/` itself, but Karthik should know it exists.** Without it, the local
`progressStore` row can itself be stale: `src/features/sync/useAutoSync.ts` (mounted once, at the
app root) only re-syncs on an actual NetInfo offline→online EDGE, and backgrounding/foregrounding
the app while the connection never drops — the common case — fires no such edge. A book advanced on
a second device while this one sat merely backgrounded, not relaunched, would otherwise resume from
a stale local position, and a write from this device afterward would diverge from a starting point
it never actually caught up to. `syncEngine.run()` is safe to call this way — concurrent calls share
one run rather than racing, so this costs nothing extra when `useAutoSync`'s own trigger already has
one in flight, and it never rejects (`execute()` catches internally).

**An already-open EPUB/PDF screen is covered too — by asking, not by jumping silently.**
`ReaderRouteScreen.tsx` subscribes to `progressStore.subscribe()` (fired on every local write AND
on every pulled server record that actually applies — `syncableTable.ts`'s own doc) once the initial
resume has resolved. On each notification it re-reads `currentLocator()` and compares it (via
`readerProgressStore.ts`'s `locatorsEqual`, not `===`) against what is CURRENTLY DISPLAYED
(`toLocator(lastPositionRef.current)`) — stable to compare against because text only moves on a
discrete `relocated` event. Equal means "unchanged, or an echo of this device's own write," and
nothing happens. Different means another device genuinely moved this book while this one was open,
and `Alert.alert` offers a choice rather than silently relocating a reader who may already be well
past either position: "Continue here" flushes the CURRENT on-screen position through with a fresh,
later timestamp (wins the next comparison anywhere else this book syncs to); "Resume from there"
adopts the incoming locator as a new `initialTarget` and forces a remount (`resumeGeneration` folded
into `ReaderScreen`'s `key`) — the same mechanism a cold-start resume already needs, since
`ReaderScreen`'s own contract says a new `initialTarget` requires a new instance, not a live prop
change. Either choice goes through the same `progressStore`/outbox path every other write does, so a
second device converges on it the ordinary way, next time it syncs.

**AUDIO does NOT use that shape — it gates the Play button instead, and that is a deliberate
divergence, not a gap to close later.** A background subscription is wrong for audio specifically:
position drifts continuously WHILE PLAYING, and this device's own throttled writes
(`AUDIO_PROGRESS_WRITE_THROTTLE_MS`) still land during that time, so a subscription comparing
against a moving position would flag this device's own advancing playback as a conflict roughly
every throttle interval — and a genuinely idle second device with the same book open would see the
same false alarms every time its own sync engine happened to pull. `AudioPlayerScreen.tsx` instead
takes an `onBeforePlay?: () => Promise<boolean>` prop — resolve `true` to let `player.play()`
proceed, `false` to refuse — and disables the Play button (showing "Checking…") for the promise's
whole duration, so a slow check cannot race a second tap into a second one.
`AudioPlayerRouteScreen.tsx` implements the gate: it tracks `lastPausedPositionSecondsRef`, set ONLY
by `onPositionCommit` (pause/seek/unmount — never by the continuous `onPositionChange` ticks), and
on every Play press awaits a fresh `syncEngine.run()` + `currentLocator()` and compares the two
PAUSED positions. **Within `CONFLICT_THRESHOLD_MS` (5s), it resolves last-write-wins SILENTLY rather
than merely ignoring the difference**: `syncEngine.run()` already resolved local-vs-remote for this
exact row (`syncableTable.ts`'s row-level LWW), so the freshly-read value is not a guess, it is the
answer — `lastPausedPositionSecondsRef` is updated to it before returning `true`, so the NEXT
play-gate check (and the next write) compares against/builds on the winning position instead of the
one that just lost. No reseek, no remount — a sub-5s difference is inaudible on resume. Past the
threshold, it escalates to the same `Alert.alert` choice `ReaderRouteScreen.tsx` uses, and playback
is blocked until the user answers. This means audio and text differ on purpose: EPUB/PDF can warn
about a divergence while the reader keeps reading (nothing is running that a stale read could
corrupt); audio's "keep going" is an OS-level irreversible action, so audio checks IMMEDIATELY
BEFORE it, not passively in the background. Porting one screen's mechanism onto the other verbatim
would reintroduce exactly the failure mode each shape was chosen to avoid.

The corrupt/legacy-row fallback hazard in `progressStore.currentLocator()` — a null or unparseable
`locator` column on ANY row gets reported as `{type:'PDF', page: row.offset}` — is **fixed**, by
`ce23884` (2026-09-07): only a genuinely `null` legacy-row locator still gets that fallback; a
corrupt-but-non-null one returns `null`, which both `ReaderRouteScreen.tsx` and
`AudioPlayerRouteScreen.tsx` already treat as "no saved position." See
`src/shared/contracts/CONTRACT_ALIGNMENT.md`'s audio-progress section and the rewritten pin in
`src/features/sync/contractConformance.test.ts`.

**An already-open EPUB/PDF screen also pulls on its own now, not only at resume.** The
already-open-screen subscription above tells you when a pulled record changed something; it does not
make anything pull. `useAutoSync.ts` is strictly edge-triggered (a NetInfo offline→online transition,
mounted once at the app root) and the resume effect's own `syncEngine.run()` call fires exactly once,
so a book left open and foregrounded the whole time while another device writes was invisible until
*something else* happened to trigger a sync. `ReaderRouteScreen.tsx` closes that with two
Reader-only mechanisms, both calling the same public `syncEngine.run()`: an `AppState` listener that
pulls on the edge into `'active'` (covers backgrounding/foregrounding without a connectivity drop),
and a `READER_LIVE_SYNC_POLL_MS` (2-minute) `setInterval` that runs only while the screen is
resolved and the app is foregrounded, torn down on backgrounding and on unmount/book-switch.
**`AudioPlayerRouteScreen.tsx` deliberately does NOT get either mechanism** — it already re-checks
synchronously at the one moment that matters (`onBeforePlay`, immediately before an irreversible
`play()`), and a background poll would false-positive against its own continuous position drift the
same way a subscription would (see this section's own audio-divergence paragraph above).

**A conflict Alert left unanswered on the same book no longer freezes on the first notification's
data.** `conflictPendingRef` still suppresses stacking a SECOND `Alert.alert` while one is pending —
`Alert.alert` has no imperative dismiss or update — but a `latestIncomingRef` behind it keeps
advancing on every further `progressStore` notification for that book. "Resume from there" adopts
whichever locator is latest at the moment it's finally pressed, not whichever arrived first. This is
deliberately not a timeout/auto-dismiss: that would make an implicit choice for the user, which is
exactly what this whole mechanism exists to avoid for EPUB/PDF (unlike audio's immediate-action
gate, where nothing is running that a stale read could corrupt).

**An active TTS session is paused the instant a conflict is found, before the Alert shows — because
polling made "the Alert can appear while `autoContinueChapter` is mid-chapter" a real case, not a
theoretical one.** `ReaderScreen` exposes exactly one thing outward for this:
`ReaderScreenHandle.pauseTtsIfSpeaking()` (a `forwardRef`/`useImperativeHandle` pair, reading through
the same `ttsSessionRef` `tearDownAndLock` already uses, so it costs nothing extra to keep current).
`ReaderRouteScreen.tsx` calls it right before `Alert.alert`, for two reasons that both matter:
`autoContinueChapter` (Reader accessibility rule 3) would otherwise keep moving `lastPositionRef`
for as long as the dialog sits unanswered, making "the currently displayed position" a moving
target; and TTS speaking over whatever a screen reader announces for the Alert itself is exactly the
"neither ducks" collision that rule already names for announcements. Left paused either way the user
answers — no auto-resume, same "never silently continue" reasoning as the rest of this mechanism.
**This is a Reader-internal seam, not a new crossing of `TTS_PROVIDER.md`'s Reader/Accessibility
boundary**: the `useTtsSession` hook instance itself is still only ever called from
`ReaderScreen.tsx`, and `pauseTtsIfSpeaking()` merely re-exposes that instance's own already-existing
`status`/`pause()` one level up, to another Reader file.

**Audiobooks now get a live check too, but it is a SEPARATE mechanism from the play-gate above, and
each owns a different moment.** `handleBeforePlay` owns "resuming from a paused, at-rest position"
(unchanged). A second effect in `AudioPlayerRouteScreen.tsx` subscribes to `progressStore` and
handles "a fresher record lands while this device is already playing" — gated on
`AudioPlayerScreenHandle.isPlaying()` (a fresh read of the native player, not a snapshot), so it
never runs during the paused case the play-gate already owns. On a genuine divergence (past the same
`CONFLICT_THRESHOLD_MS` the play-gate uses) it calls `AudioPlayerScreenHandle.pause()` — stopping
playback BEFORE the Alert shows, both so the compared position stops moving and so the reader is not
left listening to audio that no longer matches where the app is about to say it is — then shows the
identical, compulsory `Alert.alert`. **This is not the "earlier version… rejected" shape this file's
own header used to warn against** — that rejection was specifically about comparing against a value
that only updates at pause/seek/unmount (stale the instant playback resumes, which really would
false-positive on every throttled write); the live effect instead compares against
`currentPositionSeconds()`, a fresh read of the player's OWN live position, which is what makes the
`CONFLICT_THRESHOLD_MS` tolerance correctly absorb this device's own echo instead of flagging it.
Both mechanisms share one `conflictPendingRef` guard (only one dialog up at a time) and a
`latestIncomingRef` (mirroring `ReaderRouteScreen.tsx`'s own fix, for the same reason: a second
notification arriving while the live-conflict Alert is up still needs somewhere to land).

**One confirmed edge neither the play-gate NOR the live check covers**: `setActiveForLockScreen`
wires the OS lock-screen/Control-Center/media-notification Play and Toggle commands to expo-audio's
NATIVE player directly. Resuming from there never runs `onBeforePlay`, and — because it also never
goes through `progressStore` — the live-conflict effect has nothing to react to either. Closing it
would mean either patching expo-audio to route the remote command through JS first, or dropping
lock-screen transport controls entirely — both are real product trade-offs, not a follow-up to make
unilaterally, so this is recorded rather than fixed.

**The conflict `Alert` is compulsory, EXPLICITLY, on both screens.** `Alert.alert`'s 4th argument is
`{ cancelable: false }` on the `ReaderRouteScreen.tsx` and `AudioPlayerRouteScreen.tsx` calls alike.
This was already the effective behaviour without it — Android's own `Alert.alert` defaults
`cancelable` to `false` unless overridden (`react-native/Libraries/Alert/Alert.js`), and iOS's
`.alert`-style `UIAlertController` has no tap-outside-to-dismiss gesture to begin with (that only
exists for `.actionSheet` style) — but "the reader cannot read past this without resolving it" is a
real product requirement, not an accident of an unset default, so it is written down rather than
left for the next person to flip by passing `cancelable: true` for a nicer-seeming UX. Pinned by
`ReaderRouteScreen.test.tsx`/`AudioPlayerRouteScreen.test.tsx`'s own `Alert.alert` assertions, which
now check all four arguments.

**The poll only closes the gap to ~2 minutes, not to zero — that ceiling is a stated trade-off, not
an oversight, and it does not mean either screen can silently lose progress inside that window.**
Applies identically to `READER_LIVE_SYNC_POLL_MS` (EPUB/PDF) and `AUDIO_LIVE_SYNC_POLL_MS` (audio) —
same interval, same reasoning, same trade-off; audio needed its own poll for a reason worth stating
because it's easy to miss: the live-conflict effect above only REACTS to a `progressStore` change,
it does not itself cause one, so without a poll pulling on its own, that effect would sit correctly
built but permanently inert on stable wifi (no NetInfo edge ever fires, and nothing else calls
`syncEngine.run()` while the screen just sits open, playing or not).

Two things are true at once here. First, every comparison either mechanism EVER makes is against a
genuinely CURRENT value at the moment it runs — Reader re-reads `toLocator(lastPositionRef.current)`
fresh on every notification; audio's live-conflict effect reads `currentPositionSeconds()` straight
off the native player, fresher still, since text only moves on a discrete event while audio moves
continuously — so nothing about either poll's 2-minute cadence makes any SINGLE comparison stale; it
only bounds how soon a comparison happens at all. Second, and this is the part worth being explicit
about: for up to that ~2 minutes (or until the next foreground edge, whichever comes first), a
device can keep advancing and writing its own throttled progress while a genuinely newer remote
write from another device sits undetected. Because conflict resolution is last-write-wins by
timestamp (`syncableTable.ts`'s `isAtOrAfter`), if this device's own next write lands with a LATER
timestamp than that undetected remote write, the remote write is rejected as stale the moment the
poll finally pulls it — `applyServerRecord` returns `false`, `notifyChanged()` never fires, and the
Alert never appears at all for that particular remote write, because by the time it's checked this
device has already legitimately moved past it. This is not data loss on THIS device (nothing here is
ever overwritten without the user's own explicit "Continue here"/"Resume from there" choice, and for
audio, playback is also explicitly paused before that choice is offered) — it is the other device's
write losing a race it was never told it was in. That race exists in any poll-based (not push-based)
design, and a 2-minute interval was a deliberate choice among the options presented when this was
built (see `READER_LIVE_SYNC_POLL_MS`'s own comment) — shortening it narrows the race window but
cannot close it to zero without a server-push mechanism this app does not have.

**Every `syncEngine.run()` call site that cares about ONE specific book goes through a
`syncForThisBook()` helper now, in both route screens — a real gap, not a hypothetical one, found
while auditing the poll additions above.** `syncEngine.run()`'s regular sweep only refreshes
progress for books with a local `downloads` row (`syncEngine.ts`'s own `pullBook` doc) — a book read
online without ever being downloaded is invisible to it, no matter how long either device stays
online. `ReaderRouteScreen.tsx`'s original resume effect already knew this and top-up'd via
`syncEngine.pullBook(bookId)`, but that top-up lived ONLY in the resume effect — the poll and
foreground-edge effects added above called plain `syncEngine.run()` directly, so they silently never
refreshed an undownloaded book's progress, indefinitely, even though the resume-time check worked
fine. `AudioPlayerRouteScreen.tsx` had it WORSE: it never had this top-up anywhere, not even at
resume, not even in the original play-gate (`handleBeforePlay`) — meaning cross-device conflict
detection for a streamed-without-downloading audiobook never worked at all, from the feature's first
commit. Both files now define `syncForThisBook()` once and route every relevant call site through it
(the resume effect, the poll/foreground-edge effect, and — for audio — `handleBeforePlay` too).
Pinned by an `'an audiobook read online without ever being downloaded'` describe block in
`AudioPlayerRouteScreen.test.tsx` (mirroring `ReaderRouteScreen.test.tsx`'s existing one) and by a
dedicated test in each file's live-pull describe block asserting `pullBook` fires again on the
foreground edge, not just at resume.

## Verifying a change

```
npm test          # jest
npm run typecheck # tsc --noEmit
npm run lint      # eslint --max-warnings=0
```

All three must pass. For reader changes that affect rendering, also run it on the simulator
(`npm run ios`) — `expo-dev-client` is required; Expo Go cannot load the crypto native modules.

**Verifying a local Android release build (`./gradlew assembleRelease`) has two sharp edges** —
a silent `EXPO_PUBLIC_*` env-var fallback and a stale-dev-client-state trap that makes a working
release APK suddenly show the Expo dev-client launcher instead of the app. See
`ANDROID_RELEASE_BUILD_NOTES.md` before chasing either symptom again.

## Comment style in this codebase

Comments explain **decisions and traps**, not what the code plainly does — why a whitelist includes
`about:*`, why teardown is its own effect, why `require()` appears in a `.ts` file. Match that.
Do not leave historical narrative ("this used to be…") once it stops being load-bearing, and do not
let prose describe a state the code has moved past.
