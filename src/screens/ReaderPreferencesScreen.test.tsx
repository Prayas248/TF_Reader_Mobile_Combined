// src/screens/ReaderPreferencesScreen.test.tsx
// Reader preferences — the screen, its two sections, and Restore defaults.
//
// DRIVEN THROUGH THE HOOK SEAM, NOT AROUND IT. Every test injects a fake
// `PrefsSource` via the screen's `prefsSource` prop and asserts on what reached
// it. Nothing here mocks `useReaderPrefs`: mocking the hook would test that the
// screen calls a function, where injecting the source tests that a tap becomes
// the right write. The hook's own rules — the nested-group spread, the
// optimistic rollback — are covered in useReaderPrefs.test.ts.
//
// `await render(...)` is required — RTL 14's render is async. See App.test.tsx.
// `await act(async () => ...)` where a callback has to be fired outside a press;
// a bare synchronous `act()` corrupts every later render in the file. See the
// header of useReaderPrefs.test.ts, which records why.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { DEFAULT_PREFS } from '@/shared/contracts';
import type { PrefsSource, PrefsValues } from '@/features/personalization/useReaderPrefs';
import { FONT_FAMILY_OPTIONS, THEME_OPTIONS } from '@/features/personalization/prefsOptions';

import ReaderPreferencesScreen from './ReaderPreferencesScreen';

// Offline is the screen's own axis, read from `useNetworkStatus` rather than from
// the hook — prefs are local-first, so connectivity never gates a write. Mocked
// so the banner and the "controls stay live" rule can both be asserted.
const mockIsOnline = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockIsOnline(),
}));

// LayoutSection reads this to decide whether "Double" is offered — see its own
// header note. Defaults to a wide (tablet) width so every test that does not
// care about the breakpoint sees both spread options, matching the fixture's
// pre-existing behaviour. Mocked at its OWN defining module
// (react-native/Libraries/Utilities/useWindowDimensions), not by spreading the
// whole 'react-native' barrel — that barrel lazily defines its exports as
// getters for native modules with no binary in the test environment
// (`DevMenu`), and spreading it forces every one of them to evaluate eagerly.
const mockUseWindowDimensions = jest.fn(() => ({ width: 1024 }) as never);
const mockWindowWidth = (width: number) => mockUseWindowDimensions.mockReturnValue({ width } as never);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockUseWindowDimensions(),
}));

const STORED: PrefsValues = {
  ...DEFAULT_PREFS,
  theme: 'sepia',
  font: { family: 'Lora', customFontUri: 'file:///fonts/custom.ttf' },
};

function fakeSource(overrides: Partial<PrefsSource> = {}): PrefsSource {
  return {
    getPrefs: jest.fn(() => Promise.resolve(STORED)),
    savePrefs: jest.fn(() => Promise.resolve()),
    resetPrefs: jest.fn(() => Promise.resolve()),
    subscribe: jest.fn(() => () => {}),
    ...overrides,
  };
}

/** Renders and waits for the first read to land. */
async function renderReady(source: PrefsSource) {
  await render(<ReaderPreferencesScreen prefsSource={source} />);
  await waitFor(() => expect(screen.getByText('Theme')).toBeTruthy());
}

// SCOPED QUERIES, AND NOT FOR NEATNESS. `Tabs` hardcodes `testID="tabs"` and
// `tabs-tab-<id>`, this screen renders two of them, and BOTH have a 'system'
// option — so `tabs-tab-system` and the label "System" are genuinely ambiguous
// at screen level. Every option assertion below scopes to its own section.
const themeSection = () => within(screen.getByTestId('theme-section'));
const fontSection = () => within(screen.getByTestId('font-section'));
const layoutSection = () => within(screen.getByTestId('layout-section'));
const typographySection = () => within(screen.getByTestId('typography-section'));
const zoomSection = () => within(screen.getByTestId('zoom-section'));

afterEach(() => {
  mockIsOnline.mockReturnValue(true);
  mockUseWindowDimensions.mockReturnValue({ width: 1024 } as never);
});

describe('ReaderPreferencesScreen structure', () => {
  it('renders Theme, Font, Layout, Typography and Zoom sections', async () => {
    await renderReady(fakeSource());

    expect(screen.getByText('Theme')).toBeTruthy();
    expect(screen.getByText('Font')).toBeTruthy();
    expect(screen.getByText('Reading style')).toBeTruthy();
    expect(screen.getByText('Page view')).toBeTruthy();
    expect(screen.getByTestId('typography-section')).toBeTruthy();
    expect(screen.getByTestId('zoom-section')).toBeTruthy();
  });

  // Never rendered: identity and sync plumbing, plus lineHeight and the
  // accessibility flags, which are either not wired in the reader WebView yet
  // or belong to other surfaces. Zoom is NOT on this list any more — it moved
  // to a dedicated case below, now that it is a real section.
  it('renders none of the fields this screen must not show', async () => {
    await renderReady(fakeSource());

    for (const forbidden of [/line height/i, /userId/i, /updatedAt/i, /isDeleted/i, /synced/i]) {
      expect(screen.queryByText(forbidden)).toBeNull();
    }
  });
});

describe('ReaderPreferencesScreen theme section', () => {
  it('offers exactly the four theme options', async () => {
    await renderReady(fakeSource());

    for (const option of THEME_OPTIONS) {
      expect(themeSection().getByTestId(`tabs-tab-${option.id}`)).toBeTruthy();
      expect(themeSection().getByText(option.label)).toBeTruthy();
    }
  });

  // `highContrast` is a real member of the contract's Theme union, deliberately
  // not offered: it pairs with `AccessibilityPrefs.highContrast`, which prefs.ts
  // marks as pending Hruthik's sign-off.
  it('does not offer high contrast', async () => {
    await renderReady(fakeSource());

    expect(screen.queryByText(/high.?contrast/i)).toBeNull();
  });

  it('marks the stored theme as the selected option', async () => {
    await renderReady(fakeSource());

    expect(themeSection().getByTestId('tabs-tab-sepia').props.accessibilityState.selected).toBe(
      true,
    );
    expect(themeSection().getByTestId('tabs-tab-light').props.accessibilityState.selected).toBe(
      false,
    );
  });

  it('writes the picked theme through the seam', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent.press(themeSection().getByText('Dark'));

    expect(source.savePrefs).toHaveBeenCalledWith({ theme: 'dark' });
  });

  // A theme set from another device, or from the accessibility surface. `Tabs`
  // renders nothing active, which is right — a wrong highlight is worse than
  // none — and the section says so rather than looking broken.
  it('selects nothing and explains itself when the stored theme is not an option', async () => {
    const source = fakeSource({
      getPrefs: jest.fn(() => Promise.resolve({ ...STORED, theme: 'highContrast' as const })),
    });
    await renderReady(source);

    for (const option of THEME_OPTIONS) {
      expect(
        themeSection().getByTestId(`tabs-tab-${option.id}`).props.accessibilityState.selected,
      ).toBe(false);
    }
    expect(screen.getByText(/set elsewhere/i)).toBeTruthy();
  });
});

describe('ReaderPreferencesScreen layout section', () => {
  it('offers exactly the flow and spread options', async () => {
    await renderReady(fakeSource());

    for (const id of ['paginated', 'scrolled-doc']) {
      expect(layoutSection().getByTestId(`tabs-tab-${id}`)).toBeTruthy();
    }
    for (const id of ['single', 'double']) {
      expect(layoutSection().getByTestId(`tabs-tab-${id}`)).toBeTruthy();
    }
  });

  it('marks the stored flow and spread as the selected options', async () => {
    await renderReady(fakeSource());

    // STORED carries DEFAULT_PREFS.layout: paginated + single.
    expect(
      layoutSection().getByTestId('tabs-tab-paginated').props.accessibilityState.selected,
    ).toBe(true);
    expect(layoutSection().getByTestId('tabs-tab-single').props.accessibilityState.selected).toBe(
      true,
    );
  });

  // Same load-bearing rule as the font section: `layout` carries two fields, and
  // a patch built from only the one that changed would drop the other.
  it('writes the picked flow through the seam, spreading the group', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent.press(layoutSection().getByTestId('tabs-tab-scrolled-doc'));

    expect(source.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'scrolled-doc', spread: 'single' },
    });
  });

  it('writes the picked spread through the seam, spreading the group', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent.press(layoutSection().getByTestId('tabs-tab-double'));

    expect(source.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'paginated', spread: 'double' },
    });
  });

  // epub.js gates rendition.spread('double') at 800px (its own minSpreadWidth),
  // so below that "Double" is a no-op for EPUB. This screen has no book format
  // to condition on, so it hides the option on a phone-sized screen entirely
  // (the "skip it" option the requirements name) rather than leave a control
  // on screen that silently does nothing for EPUB.
  it('hides Double on a phone-sized screen and explains itself', async () => {
    mockWindowWidth(390);
    await renderReady(fakeSource());

    expect(layoutSection().getByTestId('tabs-tab-single')).toBeTruthy();
    expect(layoutSection().queryByTestId('tabs-tab-double')).toBeNull();
    expect(screen.getByText(/iPad-sized screen/i)).toBeTruthy();
  });

  it('offers Double on a tablet-sized screen, with no note', async () => {
    mockWindowWidth(1024);
    await renderReady(fakeSource());

    expect(layoutSection().getByTestId('tabs-tab-double')).toBeTruthy();
    expect(screen.queryByText(/iPad-sized screen/i)).toBeNull();
  });
});

describe('ReaderPreferencesScreen font section', () => {
  // The seven options live inside a `BottomSheet`, which renders nothing
  // until opened — see BottomSheet.test.tsx. `waitFor` covers its own
  // setTimeout(0)-then-animate open, the same way ShelfScreen.test.tsx waits
  // out FilterSortSheet.
  async function openFontPicker() {
    fireEvent.press(fontSection().getByTestId('font-picker-trigger'));
    await waitFor(() => expect(screen.getByTestId('font-picker-sheet')).toBeTruthy());
  }

  it('shows the stored family on the trigger', async () => {
    await renderReady(fakeSource());

    expect(fontSection().getByText('Lora')).toBeTruthy();
  });

  // Scoped to the section — Typography carries its own "EPUB only" hint too,
  // so an unscoped query here would be ambiguous.
  it('says the choice is EPUB only', async () => {
    await renderReady(fakeSource());

    expect(fontSection().getByText(/EPUB only/i)).toBeTruthy();
  });

  it('offers exactly the seven provisional font options once opened', async () => {
    await renderReady(fakeSource());
    await openFontPicker();

    for (const option of FONT_FAMILY_OPTIONS) {
      expect(screen.getByTestId(`font-option-${option.id}`)).toBeTruthy();
    }
  });

  it('marks the stored family as the selected option', async () => {
    await renderReady(fakeSource());
    await openFontPicker();

    expect(screen.getByTestId('font-option-Lora').props.accessibilityState.selected).toBe(true);
  });

  // The screen's half of the hook's spread rule: the write must carry the
  // family the reader picked AND keep the custom font URI they already had.
  it('writes the picked family through the seam without dropping customFontUri', async () => {
    const source = fakeSource();
    await renderReady(source);
    await openFontPicker();

    fireEvent.press(screen.getByTestId('font-option-Merriweather'));

    expect(source.savePrefs).toHaveBeenCalledWith({
      font: { family: 'Merriweather', customFontUri: 'file:///fonts/custom.ttf' },
    });
  });

  it('closes the sheet once a font is picked', async () => {
    await renderReady(fakeSource());
    await openFontPicker();

    fireEvent.press(screen.getByTestId('font-option-Merriweather'));

    await waitFor(() => expect(screen.queryByTestId('font-picker-sheet')).toBeNull());
  });

  it('selects nothing and names the current face when it is not an option', async () => {
    const source = fakeSource({
      getPrefs: jest.fn(() => Promise.resolve({ ...STORED, font: { family: 'Georgia' } })),
    });
    await renderReady(source);

    // Exact match: the note below also mentions "Georgia" in a sentence, and
    // an exact string match does not confuse the two.
    expect(fontSection().getByText('Georgia')).toBeTruthy();
    expect(fontSection().getByText(/is not one of these options/i)).toBeTruthy();

    await openFontPicker();
    for (const option of FONT_FAMILY_OPTIONS) {
      expect(
        screen.getByTestId(`font-option-${option.id}`).props.accessibilityState.selected,
      ).toBe(false);
    }
  });
});

describe('ReaderPreferencesScreen typography section', () => {
  it('says the choice is EPUB only', async () => {
    await renderReady(fakeSource());

    expect(typographySection().getByText(/EPUB only/i)).toBeTruthy();
  });

  it('does not render a line height control — not wired in the reader yet', async () => {
    await renderReady(fakeSource());

    expect(typographySection().queryByTestId('typography-line-height-slider')).toBeNull();
    expect(typographySection().queryByText(/line height/i)).toBeNull();
  });

  it('renders a slider for font size, letter spacing and page margins', async () => {
    await renderReady(fakeSource());

    expect(typographySection().getByTestId('typography-font-size-slider')).toBeTruthy();
    expect(typographySection().getByTestId('typography-letter-spacing-slider')).toBeTruthy();
    expect(typographySection().getByTestId('typography-margins-slider')).toBeTruthy();
  });

  it('labels font size in pt, not px', async () => {
    // Margins defaults to 16 too — a distinct value here is what makes "16px"
    // unambiguous evidence of a mislabelled font size rather than a
    // coincidental match against the margins readout.
    const source = fakeSource({
      getPrefs: jest.fn(() =>
        Promise.resolve({ ...STORED, typography: { ...STORED.typography, margins: 24 } }),
      ),
    });
    await renderReady(source);

    expect(typographySection().getByText('16pt')).toBeTruthy();
    expect(typographySection().queryByText('16px')).toBeNull();
  });

  it('shows "None" for letter spacing at zero, not "0px"', async () => {
    await renderReady(fakeSource());

    // STORED carries DEFAULT_PREFS.typography, so spacing 0.
    expect(typographySection().getByText('None')).toBeTruthy();
    expect(typographySection().queryByText('0px')).toBeNull();
  });

  it('shows the px value once letter spacing is off zero', async () => {
    const source = fakeSource({
      getPrefs: jest.fn(() =>
        Promise.resolve({ ...STORED, typography: { ...STORED.typography, spacing: 2 } }),
      ),
    });
    await renderReady(source);

    expect(typographySection().getByText('2px')).toBeTruthy();
    expect(typographySection().queryByText('None')).toBeNull();
  });

  // Save-on-release: the section wires the slider's release event straight to
  // the seam, spreading the rest of the typography group.
  it('writes the released font size through the seam, spreading the group', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent(
      typographySection().getByTestId('typography-font-size-slider'),
      'slidingComplete',
      20,
    );

    expect(source.savePrefs).toHaveBeenCalledWith({
      typography: { size: 20, lineHeight: 1.5, spacing: 0, margins: 16 },
    });
  });

  it('writes the released letter spacing through the seam, spreading the group', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent(
      typographySection().getByTestId('typography-letter-spacing-slider'),
      'slidingComplete',
      2,
    );

    expect(source.savePrefs).toHaveBeenCalledWith({
      typography: { size: 16, lineHeight: 1.5, spacing: 2, margins: 16 },
    });
  });

  it('writes the released page margins through the seam, spreading the group', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent(
      typographySection().getByTestId('typography-margins-slider'),
      'slidingComplete',
      32,
    );

    expect(source.savePrefs).toHaveBeenCalledWith({
      typography: { size: 16, lineHeight: 1.5, spacing: 0, margins: 32 },
    });
  });

  it('allows page margins up to 64px', async () => {
    await renderReady(fakeSource());

    const slider = typographySection().getByTestId('typography-margins-slider');
    expect(slider.props.maximumValue).toBe(64);
  });
});

describe('ReaderPreferencesScreen zoom section', () => {
  it('says the choice is PDF only', async () => {
    await renderReady(fakeSource());

    expect(zoomSection().getByText(/PDF only/i)).toBeTruthy();
  });

  it('renders a slider defaulting to 100%', async () => {
    await renderReady(fakeSource());

    expect(zoomSection().getByTestId('zoom-level-slider')).toBeTruthy();
    // STORED carries DEFAULT_PREFS.zoom, so level 1.0.
    expect(zoomSection().getByText('100%')).toBeTruthy();
  });

  it('writes the released zoom level through the seam', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent(zoomSection().getByTestId('zoom-level-slider'), 'slidingComplete', 1.5);

    expect(source.savePrefs).toHaveBeenCalledWith({ zoom: { level: 1.5 } });
  });
});

describe('ReaderPreferencesScreen restore defaults', () => {
  it('offers the action', async () => {
    await renderReady(fakeSource());

    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeTruthy();
  });

  it('calls resetPrefs, and does not write the groups one at a time', async () => {
    const source = fakeSource();
    await renderReady(source);

    fireEvent.press(screen.getByText('Restore defaults'));

    expect(source.resetPrefs).toHaveBeenCalledTimes(1);
    expect(source.savePrefs).not.toHaveBeenCalled();
  });

  it('returns the controls to the contract defaults', async () => {
    await renderReady(fakeSource());

    fireEvent.press(screen.getByText('Restore defaults'));

    // DEFAULT_PREFS is theme 'system' and family 'system' — one per section,
    // which is exactly why these queries have to be scoped.
    await waitFor(() =>
      expect(themeSection().getByTestId('tabs-tab-system').props.accessibilityState.selected).toBe(
        true,
      ),
    );
    // Font's own control is a picker trigger, not a `Tabs` bar — the reset
    // shows up as the trigger's displayed value rather than a selected segment.
    expect(fontSection().getByText('System')).toBeTruthy();
  });
});

describe('ReaderPreferencesScreen states', () => {
  it('renders skeletons, and no controls, while the first read is in flight', async () => {
    const source = fakeSource({ getPrefs: jest.fn(() => new Promise<PrefsValues>(() => {})) });
    await render(<ReaderPreferencesScreen prefsSource={source} />);

    expect(screen.getByTestId('reader-prefs-skeleton')).toBeTruthy();
    expect(screen.queryByText('Theme')).toBeNull();
  });

  it('renders an error with a retry when the read fails', async () => {
    const source = fakeSource({ getPrefs: jest.fn(() => Promise.reject(new Error('nope'))) });
    await render(<ReaderPreferencesScreen prefsSource={source} />);

    await waitFor(() =>
      expect(screen.getByText("We couldn't load your reading preferences.")).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('recovers when retry succeeds', async () => {
    const getPrefs = jest
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(STORED);
    await render(<ReaderPreferencesScreen prefsSource={fakeSource({ getPrefs })} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Theme')).toBeTruthy());
  });

  // OFFLINE IS NOT A BLOCKING STATE. Prefs are written locally and reconciled by
  // LWW on `updatedAt`, so the banner is informational and every control stays
  // live behind it. This is the test that stops someone "fixing" the screen by
  // disabling it offline.
  it('shows the offline banner and keeps every control usable behind it', async () => {
    mockIsOnline.mockReturnValue(false);
    const source = fakeSource();
    await renderReady(source);

    expect(screen.getByText(/offline/i)).toBeTruthy();

    fireEvent.press(themeSection().getByText('Dark'));
    expect(source.savePrefs).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('reports a failed write inline, leaving the screen on its content', async () => {
    const source = fakeSource({ savePrefs: jest.fn(() => Promise.reject(new Error('nope'))) });
    await renderReady(source);

    fireEvent.press(themeSection().getByText('Dark'));

    await waitFor(() => expect(screen.getByText(/didn't save/i)).toBeTruthy());
    // Still the content, not an error page — the values on screen are correct
    // because the hook rolled the failed one back.
    expect(screen.getByText('Theme')).toBeTruthy();
    expect(themeSection().getByTestId('tabs-tab-sepia').props.accessibilityState.selected).toBe(
      true,
    );
  });
});

describe('ReaderPreferencesScreen accessibility', () => {
  it('announces each section heading as a header', async () => {
    await renderReady(fakeSource());

    const headers = screen.getAllByRole('header');
    const labels = headers.map((header) => header.props.children);

    expect(labels).toContain('Theme');
    expect(labels).toContain('Font');
  });

  it('announces the selected option, so the current value is not colour-only', async () => {
    await renderReady(fakeSource());

    expect(themeSection().getByTestId('tabs-tab-sepia').props.accessibilityState.selected).toBe(
      true,
    );
  });

  it('announces Restore defaults as a button under its visible name', async () => {
    await renderReady(fakeSource());

    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeTruthy();
  });

  it('announces a failed write as an alert', async () => {
    const source = fakeSource({ savePrefs: jest.fn(() => Promise.reject(new Error('nope'))) });
    await renderReady(source);

    fireEvent.press(themeSection().getByText('Dark'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
