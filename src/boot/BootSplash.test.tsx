// src/boot/BootSplash.test.tsx
// BootSplash's only real behaviour: it shows the boot identity, and it tells
// its caller exactly once when it is safe to stop rendering it. The
// animation timings are asserted by advancing fake timers rather than
// waiting on real ones — `jest.runAllTimers()` is not used here because the
// shimmer sweep is an infinite loop and would hang the test.
import { act, render, screen } from '@testing-library/react-native';

import BootSplash from './BootSplash';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BootSplash content', () => {
  it('renders the boot identity', async () => {
    await render(<BootSplash ready={false} onExited={() => {}} />);

    expect(screen.getByText('Taylor & Francis')).toBeTruthy();
    expect(screen.getByText('One Destination. The Global Publishing Ecosystem.')).toBeTruthy();
    expect(screen.getByText('Routledge')).toBeTruthy();
    expect(screen.getByText('CRC Press')).toBeTruthy();
    expect(screen.getByText('F1000')).toBeTruthy();
  });
});

describe('BootSplash exit', () => {
  it('does not exit while the app is not ready, even once the intro has finished', async () => {
    const onExited = jest.fn();
    await render(<BootSplash ready={false} onExited={onExited} />);

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(onExited).not.toHaveBeenCalled();
  });

  it('exits once the app becomes ready, after the minimum visible time has passed', async () => {
    const onExited = jest.fn();
    const { rerender } = await render(<BootSplash ready={false} onExited={onExited} />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    await rerender(<BootSplash ready onExited={onExited} />);

    // MIN_VISIBLE_MS (3500ms) started at mount, not at this rerender, so
    // only 2500ms of it is left — not yet enough, plus the exit's own
    // fill+fade (500ms more).
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(onExited).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  // The core of this ticket: a warm boot where `ready` is already true by
  // the first render must not cut the minimum visible time short — 4
  // seconds total (MIN_VISIBLE_MS 3500 + the 500ms exit fill/fade).
  it('waits out the full 4 seconds even if the app is ready from the very first frame', async () => {
    const onExited = jest.fn();
    await render(<BootSplash ready onExited={onExited} />);

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(onExited).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(onExited).toHaveBeenCalledTimes(1);
  });
});
