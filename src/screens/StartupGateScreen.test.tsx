// src/screens/StartupGateScreen.test.tsx
// Screen 00b. Navigation-only — no store to inject, no fetch. `await
// render(...)` is required, same reason AccessGateScreen.test.tsx notes: RTL
// 14's render is async.
import { render, screen, fireEvent } from '@testing-library/react-native';

import StartupGateScreen from './StartupGateScreen';

const mockReplace = jest.fn();

function makeProps() {
  return {
    navigation: { replace: mockReplace },
    route: { key: 'StartupGate', name: 'StartupGate' as const, params: undefined },
  };
}

afterEach(() => {
  mockReplace.mockClear();
});

describe('StartupGateScreen', () => {
  it('renders the sign-in prompt', async () => {
    // @ts-expect-error — hand-built props, same pattern AccessGateScreen.test.tsx uses.
    await render(<StartupGateScreen {...makeProps()} />);

    expect(screen.getByText('Sign in for the full experience')).toBeTruthy();
  });

  it('replaces itself with Main -> Profile -> SignInMethod when "Sign In" is pressed', async () => {
    // @ts-expect-error — hand-built props, same pattern AccessGateScreen.test.tsx uses.
    await render(<StartupGateScreen {...makeProps()} />);

    fireEvent.press(screen.getByTestId('startup-gate-sign-in'));

    // `initial: false` is load-bearing here, not incidental — see the
    // handler's own comment. Without it, this being the reader's first ever
    // visit to the Profile tab means ProfileStack initializes with
    // 'SignInMethod' as its ONLY history entry, and SignInMethodScreen's own
    // post-sign-in `popToTop()` becomes a no-op (already at index 0),
    // stranding the Profile tab on the sign-in chooser forever after.
    expect(mockReplace).toHaveBeenCalledWith('Main', {
      screen: 'Profile',
      params: { screen: 'SignInMethod', initial: false },
    });
  });

  it('replaces itself with Main when "Continue without signing in" is pressed', async () => {
    // @ts-expect-error — hand-built props, same pattern AccessGateScreen.test.tsx uses.
    await render(<StartupGateScreen {...makeProps()} />);

    fireEvent.press(screen.getByTestId('startup-gate-continue'));

    expect(mockReplace).toHaveBeenCalledWith('Main');
  });

  it('replaces itself with Main when the backdrop is pressed', async () => {
    // @ts-expect-error — hand-built props, same pattern AccessGateScreen.test.tsx uses.
    await render(<StartupGateScreen {...makeProps()} />);

    fireEvent.press(screen.getByLabelText('Dismiss'));

    expect(mockReplace).toHaveBeenCalledWith('Main');
  });
});
