// Owner: Reader (Ahana).
//
// Covers the property the old "temporary fixture picker" tests in App.test.tsx used to pin, now
// re-homed here because the picker itself moved: every fixture is listed, and tapping a row
// navigates to the right route with the right params. `navigation` is a hand-rolled stub rather
// than a real NavigationContainer — this is a unit test of BookListScreen's own render/press
// wiring, not an integration test of react-navigation itself.
//
// openBook() is mocked to succeed immediately — it is the STREAM-intent licence gate that runs
// BEFORE navigation; this test verifies that navigation happens AFTER it succeeds, not that
// openBook itself works (that is licenseCheck.test.ts's job).

import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { BookListScreen } from './BookListScreen';
import { openBook } from '@/features/download/openBook';
import { audioQueueStore, useAudioQueueStore } from '@/features/reader/audio/audioQueueStore';
import { selectAndPlayAudiobook, toggleAudioPlayback } from '@/features/reader/audio/audioQueueCoordinator';

jest.mock('@/features/download/openBook', () => ({
  openBook: jest.fn().mockResolvedValue(new Uint8Array()),
}));

jest.mock('@/features/reader/audio/audioQueueCoordinator', () => ({
  selectAndPlayAudiobook: jest.fn().mockResolvedValue(true),
  toggleAudioPlayback: jest.fn().mockResolvedValue(true),
  skipToNextTrack: jest.fn().mockResolvedValue(true),
  skipToPreviousTrack: jest.fn().mockResolvedValue(true),
}));

// `render` is ASYNC in @testing-library/react-native v14 — see App.test.tsx's own note.
function renderBookList(navigate: jest.Mock) {
  return render(
    <BookListScreen
      navigation={{ navigate } as never}
      route={{ key: 'BookList', name: 'BookList' } as never}
    />,
  );
}

describe('BookListScreen', () => {
  beforeEach(() => {
    audioQueueStore.getState().clearQueue();
    jest.clearAllMocks();
    jest.mocked(openBook).mockResolvedValue(new Uint8Array());
  });

  it('lists both audiobook and book fixtures in sections by default', async () => {
    const { getByText } = await renderBookList(jest.fn());

    expect(getByText('🎧 Audiobooks')).toBeTruthy();
    expect(getByText('📖 E-Books & Documents')).toBeTruthy();
    expect(getByText('EPUB')).toBeTruthy();
    expect(getByText('PDF')).toBeTruthy();
    expect(getByText('Audiobook (Encrypted)')).toBeTruthy();
    expect(getByText('Audiobook (Open Access)')).toBeTruthy();
  });

  it('switches views via filter tabs', async () => {
    const { getByLabelText, getByText, queryByText } = await renderBookList(jest.fn());

    // Switch to Audiobooks tab
    await fireEvent.press(getByLabelText('Audiobooks'));
    expect(getByText('Audiobook (Encrypted)')).toBeTruthy();
    expect(queryByText('EPUB')).toBeNull();
    expect(queryByText('PDF')).toBeNull();

    // Switch to Books tab
    await fireEvent.press(getByLabelText('Books and PDFs'));
    expect(getByText('EPUB')).toBeTruthy();
    expect(queryByText('Audiobook (Encrypted)')).toBeNull();

    // Switch back to All tab
    await fireEvent.press(getByLabelText('All items'));
    expect(getByText('Audiobook (Encrypted)')).toBeTruthy();
    expect(getByText('EPUB')).toBeTruthy();
  });

  it.each([
    ['EPUB', 'dev-sample-epub', 'EPUB'],
    ['PDF', 'dev-sample-pdf', 'PDF'],
    ['Big EPUB', 'dev-fixture-epub', 'EPUB'],
    ['Big PDF', 'dev-fixture-pdf', 'PDF'],
  ])(
    'tapping %s calls openBook then navigates to Reader with { bookId: %s, format: %s }',
    async (label, bookId, format) => {
      const navigate = jest.fn();
      const { getByText } = await renderBookList(navigate);

      await fireEvent.press(getByText(label));

      await waitFor(() => {
        expect(openBook).toHaveBeenCalledWith(bookId, format);
        expect(navigate).toHaveBeenCalledWith('Reader', { bookId, format, title: label });
      });
    },
  );

  it('does not navigate when openBook rejects', async () => {
    jest.mocked(openBook).mockRejectedValueOnce(new Error('network error'));
    const navigate = jest.fn();
    const { getByText } = await renderBookList(navigate);

    await fireEvent.press(getByText('EPUB'));

    // Give the async handler time to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(openBook).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('tapping Audiobook card triggers selectAndPlayAudiobook without navigating away', async () => {
    const navigate = jest.fn();
    const { getByText } = await renderBookList(navigate);

    await fireEvent.press(getByText('Audiobook (Encrypted)'));

    expect(selectAndPlayAudiobook).toHaveBeenCalledWith({
      bookId: 'dev-sample-audio-encrypted',
      title: 'Audiobook (Encrypted)',
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(openBook).not.toHaveBeenCalled();
  });

  it('tapping "Open Player" on audiobook row navigates to AudioPlayer', async () => {
    const navigate = jest.fn();
    const { getByLabelText } = await renderBookList(navigate);

    await fireEvent.press(getByLabelText('Open player for Audiobook (Encrypted)'));

    expect(navigate).toHaveBeenCalledWith('AudioPlayer', {
      bookId: 'dev-sample-audio-encrypted',
      title: 'Audiobook (Encrypted)',
    });
  });

  it('tapping mini player navigates to full AudioPlayer screen', async () => {
    useAudioQueueStore.getState().setQueue(
      [{ bookId: 'dev-sample-audio-encrypted' as never, title: 'Audiobook (Encrypted)' }],
      0,
    );

    const navigate = jest.fn();
    const { getByLabelText } = await renderBookList(navigate);

    await fireEvent.press(getByLabelText('Open audio player: Audiobook (Encrypted)'));

    expect(navigate).toHaveBeenCalledWith('AudioPlayer', {
      bookId: 'dev-sample-audio-encrypted',
      title: 'Audiobook (Encrypted)',
    });
  });

  it('allows adding audiobooks to queue via "Play Next" and "+ Queue"', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByLabelText } = await renderBookList(jest.fn());

    await fireEvent.press(getByLabelText('Play next: Audiobook (Encrypted)'));
    expect(audioQueueStore.getState().items).toEqual([
      { bookId: 'dev-sample-audio-encrypted', title: 'Audiobook (Encrypted)' },
    ]);
    expect(alertSpy).toHaveBeenCalledWith('Queue Updated', '"Audiobook (Encrypted)" will play next.');

    await fireEvent.press(getByLabelText('Add to queue: Audiobook (Open Access)'));
    expect(audioQueueStore.getState().items).toEqual([
      { bookId: 'dev-sample-audio-encrypted', title: 'Audiobook (Encrypted)' },
      { bookId: 'dev-sample-audio-open', title: 'Audiobook (Open Access)' },
    ]);
    expect(alertSpy).toHaveBeenCalledWith('Queue Updated', 'Added "Audiobook (Open Access)" to queue.');

    alertSpy.mockRestore();
  });

  it('toggles playback via play/switch button on active audiobook row', async () => {
    useAudioQueueStore.getState().setQueue(
      [{ bookId: 'dev-sample-audio-encrypted' as never, title: 'Audiobook (Encrypted)' }],
      0,
    );
    useAudioQueueStore.getState().setIsPlaying(true);

    const { getByLabelText } = await renderBookList(jest.fn());

    await fireEvent.press(getByLabelText('Play or switch to Audiobook (Encrypted)'));
    expect(toggleAudioPlayback).toHaveBeenCalledTimes(1);
  });

  it('does not render queue buttons for non-audio fixtures', async () => {
    const { queryByLabelText } = await renderBookList(jest.fn());
    expect(queryByLabelText('Play next: EPUB')).toBeNull();
    expect(queryByLabelText('Add to queue: EPUB')).toBeNull();
    expect(queryByLabelText('Play next: PDF')).toBeNull();
  });

  it('prevents adding a book to queue if it is already in the queue and alerts user', async () => {
    useAudioQueueStore.getState().setQueue([
      { bookId: 'dev-sample-audio-encrypted' as never, title: 'Audiobook (Encrypted)' },
    ]);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByLabelText } = await renderBookList(jest.fn());

    await fireEvent.press(getByLabelText('Add to queue: Audiobook (Encrypted)'));
    expect(audioQueueStore.getState().items).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Already in Queue',
      '"Audiobook (Encrypted)" is already in the queue.',
    );

    await fireEvent.press(getByLabelText('Play next: Audiobook (Encrypted)'));
    expect(audioQueueStore.getState().items).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Already in Queue',
      '"Audiobook (Encrypted)" is already in the queue.',
    );

    alertSpy.mockRestore();
  });
});
