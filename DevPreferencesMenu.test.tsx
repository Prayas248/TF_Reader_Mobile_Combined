// Owner: Reader (Ahana). Temp, and it goes with the file it tests.
//
// Only one behaviour added for the accessibility work is covered here now: the Flow/Spread rows
// going inert while the Reader is overriding `layout.flow` for a screen reader. The announce-gate
// coverage that used to live here moved to AccessibilitySettingsPanel.test.tsx along with the UI
// itself — the TTS on/off toggle and the two announce toggles are no longer in this menu at all.
// The rest of this menu is exercised through ReaderScreen's own prefs-application tests.

import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { Alert, Dimensions } from 'react-native';

import { prefsStore } from '@/features/personalization/prefsStore';
import { setOverrideDeclined } from '@/features/reader/a11yOverrideChoice';
import { useScreenReaderEnabled } from '@/features/reader/useScreenReaderEnabled';
import { DEFAULT_PREFS } from '@/shared/contracts';
import type { SharedPrefs } from '@/shared/contracts';

import { DevPreferencesMenu } from './DevPreferencesMenu';

jest.mock('@/features/personalization/prefsStore', () => ({
  prefsStore: {
    getPrefs: jest.fn(),
    savePrefs: jest.fn(() => Promise.resolve()),
    subscribe: jest.fn(() => () => undefined),
  },
}));

jest.mock('@/features/reader/useScreenReaderEnabled', () => ({
  useScreenReaderEnabled: jest.fn(() => false),
}));

function makePrefs(): SharedPrefs {
  return {
    ...structuredClone(DEFAULT_PREFS),
    id: 'prefs-1',
    userId: 'user-1',
    updatedAt: 0,
    isDeleted: false,
    synced: false,
  };
}

beforeEach(() => {
  jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
  jest.mocked(useScreenReaderEnabled).mockReturnValue(false);
  jest.mocked(prefsStore.savePrefs).mockClear();
  setOverrideDeclined(false);
});

async function openMenu(): Promise<void> {
  await render(<DevPreferencesMenu format="EPUB" />);
  await act(async () => {
    await Promise.resolve();
  });
  await fireEvent.press(screen.getByLabelText('Reading appearance'));
}

describe('the Layout rows while a screen reader is running', () => {
  it('leaves them alone when nothing is overridden', async () => {
    await openMenu();

    expect(screen.queryByTestId('prefs-flow-override-note')).toBeNull();
    expect(screen.getByLabelText('Flow: Paginated, selected').props.accessibilityState).toMatchObject(
      { disabled: false },
    );
  });

  it('disables them and says why once the Reader takes over flow', async () => {
    // A control with nothing to control is worse than no control — this file already applies that
    // to Zoom on EPUB. Disabled rather than hidden, because unlike Zoom this is reversible and the
    // user has to be able to find out why their toggle stopped responding.
    jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
    await openMenu();

    expect(screen.getByTestId('prefs-flow-override-note')).toBeTruthy();
    expect(
      screen.getByLabelText('Flow: Paginated, selected').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(screen.getByLabelText('Spread: Single, selected').props.accessibilityState).toMatchObject(
      { disabled: true },
    );
  });

  it('re-enables them once the user chooses to keep pages', async () => {
    // The reader's alert and this menu have to agree; they are not parent and child, which is why
    // the choice lives in a module. See a11yOverrideChoice.ts.
    jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
    await openMenu();

    await act(async () => {
      setOverrideDeclined(true);
    });

    expect(screen.queryByTestId('prefs-flow-override-note')).toBeNull();
    expect(
      screen.getByLabelText('Flow: Paginated, selected').props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('does not disable them for a reader who already chose scrolled flow', async () => {
    // Nothing was overridden, so nothing is taken over.
    const scrolled = makePrefs();
    scrolled.layout = { flow: 'scrolled-doc', spread: 'single' };
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(scrolled);
    jest.mocked(useScreenReaderEnabled).mockReturnValue(true);

    await openMenu();

    expect(screen.queryByTestId('prefs-flow-override-note')).toBeNull();
  });
});

describe('picking Double spread on a screen too narrow to show it', () => {
  // 800 is SPREAD_MIN_WIDTH — matches epub.js's own minSpreadWidth / pdfOutline.ts's
  // PDF_SPREAD_MIN_WIDTH. Values either side of it are what these tests actually depend on, not
  // the constant's own name (it isn't exported).
  const NARROW_WIDTH = 400;
  const WIDE_WIDTH = 900;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reverts to Single and warns, instead of storing an inert preference', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: NARROW_WIDTH } as never);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openMenu();

    await fireEvent.press(screen.getByLabelText('Spread: Double'));

    expect(alertSpy).toHaveBeenCalledWith('Double spread', expect.stringContaining('too narrow'));
    expect(prefsStore.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'paginated', spread: 'single' },
    });
  });

  it('applies Double normally once the screen is wide enough', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: WIDE_WIDTH } as never);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openMenu();

    await fireEvent.press(screen.getByLabelText('Spread: Double'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(prefsStore.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'paginated', spread: 'double' },
    });
  });

  it('still reverts for a narrow screen even when scrolled flow is already set — not skipped by the flow check', async () => {
    // The regression this test exists for: the narrow-screen check used to run AFTER the
    // scrolled-flow conflict check, which `return`s early — so picking Double while already in
    // scrolled flow skipped the narrow-screen check entirely and stored `double` anyway, on a
    // screen that could never show it.
    const scrolled = makePrefs();
    scrolled.layout = { flow: 'scrolled-doc', spread: 'single' };
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(scrolled);
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: NARROW_WIDTH } as never);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openMenu();

    await fireEvent.press(screen.getByLabelText('Spread: Double'));

    expect(alertSpy).toHaveBeenCalledWith('Double spread', expect.stringContaining('too narrow'));
    expect(alertSpy).not.toHaveBeenCalledWith('Layout updated', expect.anything());
    expect(prefsStore.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'scrolled-doc', spread: 'single' },
    });
  });

  it('still resolves the scrolled-flow conflict as before once the screen is wide enough', async () => {
    const scrolled = makePrefs();
    scrolled.layout = { flow: 'scrolled-doc', spread: 'single' };
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(scrolled);
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: WIDE_WIDTH } as never);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openMenu();

    await fireEvent.press(screen.getByLabelText('Spread: Double'));

    expect(alertSpy).toHaveBeenCalledWith('Layout updated', expect.stringContaining('Scrolled flow'));
    expect(prefsStore.savePrefs).toHaveBeenCalledWith({
      layout: { flow: 'paginated', spread: 'double' },
    });
  });
});
