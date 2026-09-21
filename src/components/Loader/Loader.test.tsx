// src/components/Loader/Loader.test.tsx
// Loader's contract: always shows a spinner, shows the optional title when
// given, opens on a quote (with its matching author) from the known set, and
// rotates to a DIFFERENT quote every interval — never the one just shown.
// Which quote is a) the opening one and b) each rotation lands on is random,
// so most of this mocks Math.random to pin the outcome rather than asserting
// exact wording; the "never repeats" test instead uses real randomness and
// checks an invariant the algorithm guarantees regardless of the draw.
import { act, render, screen } from '@testing-library/react-native';

import Loader from './Loader';

const QUOTE_INTERVAL_MS = 12_000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function quoteText(): string {
  return screen.getByTestId('loader-quote').props.children.join('');
}

function authorText(): string {
  return screen.getByTestId('loader-author').props.children.join('');
}

describe('Loader content', () => {
  it('renders a spinner and an attributed quote from the known set', async () => {
    await render(<Loader testID="my-loader" />);

    expect(screen.getByTestId('my-loader')).toBeTruthy();
    expect(quoteText()).toMatch(/^“.+”$/);
    expect(authorText()).toMatch(/^— .+$/);
  });

  it('picks the first quote via Math.random, not a fixed index', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);

    await render(<Loader />);

    // With Math.random pinned to 0, the initial pick is index 0.
    expect(quoteText()).toBe('“Knowledge is power.”');
    expect(authorText()).toBe('— Francis Bacon');
  });

  it('renders the optional title above the quote', async () => {
    await render(<Loader title="Loading The Origin of Species…" />);

    expect(screen.getByText('Loading The Origin of Species…')).toBeTruthy();
  });

  it('omits the title line when none is given', async () => {
    await render(<Loader />);

    expect(screen.queryByText(/Loading/)).toBeNull();
  });
});

describe('Loader quote rotation', () => {
  it('advances to a different, deterministic quote after one interval', async () => {
    // First call seeds the initial index (0 → "Knowledge is power."); the
    // second is nextQuoteIndex's one Math.random() call for the rotation.
    jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);

    await render(<Loader />);
    expect(quoteText()).toBe('“Knowledge is power.”');

    await act(async () => {
      jest.advanceTimersByTime(QUOTE_INTERVAL_MS);
    });

    // offset = 1 + floor(0 * 17) = 1 → index (0 + 1) % 18 = 1.
    expect(quoteText()).toBe(
      '“Some books are to be tasted, others to be swallowed, and some few to be chewed and digested.”',
    );
    expect(authorText()).toBe('— Francis Bacon');
  });

  it('never repeats the same quote twice in a row, across many real-random rotations', async () => {
    await render(<Loader testID="my-loader" />);

    let previous = quoteText();
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(QUOTE_INTERVAL_MS);
      });
      const current = quoteText();
      expect(current).not.toBe(previous);
      previous = current;
    }
  });
});
