import { fireEvent, render } from '@testing-library/react-native';

import ActionBar from './ActionBar';

// `render` is ASYNC in @testing-library/react-native v14 — await it.

describe('ActionBar', () => {
  describe('the three states must be distinguishable', () => {
    it('loading draws placeholders and no labels', async () => {
      const { getByTestId, queryByText } = await render(
        <ActionBar actions={['read', 'download']} state="loading" onAction={jest.fn()} />,
      );
      expect(getByTestId('action-bar-loading')).toBeTruthy();
      expect(queryByText('Read')).toBeNull();
      expect(queryByText('Download')).toBeNull();
    });

    it('error draws a retry', async () => {
      const onRetry = jest.fn();
      const { getByTestId } = await render(
        <ActionBar actions={[]} state="error" onAction={jest.fn()} onRetry={onRetry} />,
      );
      fireEvent.press(getByTestId('action-bar-retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('resolving to nothing draws nothing at all', async () => {
      const { toJSON, queryByTestId } = await render(
        <ActionBar actions={[]} onAction={jest.fn()} />,
      );
      // Not an empty View: null, so the bar contributes no height and no gap.
      expect(toJSON()).toBeNull();
      expect(queryByTestId('action-bar')).toBeNull();
    });

    it('loading and error render different trees, so they cannot be confused', async () => {
      const loading = await render(
        <ActionBar actions={['read']} state="loading" onAction={jest.fn()} />,
      );
      const failed = await render(
        <ActionBar actions={['read']} state="error" onAction={jest.fn()} onRetry={jest.fn()} />,
      );
      expect(loading.queryByTestId('action-bar-retry')).toBeNull();
      expect(failed.queryByTestId('action-button-skeleton')).toBeNull();
    });
  });

  // THE ASSERTION THIS FILE EXISTS FOR. index.html §Access: on a failed resolve,
  // "never to Download" — "Guessing towards the more generous button hands an
  // unentitled reader a file." A caller passing download must not be able to
  // make it appear.
  describe('a failed resolve never offers Download', () => {
    it('ignores a download in `actions`', async () => {
      const { queryByText, queryByTestId } = await render(
        <ActionBar
          actions={['read', 'download']}
          state="error"
          onAction={jest.fn()}
          onRetry={jest.fn()}
        />,
      );
      expect(queryByText('Download')).toBeNull();
      expect(queryByTestId('action-button-download')).toBeNull();
    });

    it('offers no action buttons at all, only the retry', async () => {
      const { queryByText, getByTestId } = await render(
        <ActionBar
          actions={['read', 'download', 'subscribe']}
          state="error"
          onAction={jest.fn()}
          onRetry={jest.fn()}
        />,
      );
      expect(queryByText('Read')).toBeNull();
      expect(queryByText('Subscribe')).toBeNull();
      expect(getByTestId('action-bar-retry')).toBeTruthy();
    });
  });

  describe('lays out whatever list it is given', () => {
    it('the unlimited-tier pair', async () => {
      const { getByText } = await render(
        <ActionBar actions={['read', 'download']} onAction={jest.fn()} />,
      );
      expect(getByText('Read')).toBeTruthy();
      expect(getByText('Download')).toBeTruthy();
    });

    it('a single action', async () => {
      const { getByText } = await render(<ActionBar actions={['signIn']} onAction={jest.fn()} />);
      expect(getByText('Sign in')).toBeTruthy();
    });

    it('reports which action was pressed', async () => {
      const onAction = jest.fn();
      const { getByTestId } = await render(
        <ActionBar actions={['read', 'download']} onAction={onAction} />,
      );
      fireEvent.press(getByTestId('action-button-download'));
      expect(onAction).toHaveBeenCalledWith('download');
    });
  });

  // Elite, 16 Aug: one Request access button to start, then either an offer straight
  // back or a queue position and the same offer later. No Download at any point.
  //
  // Every step asserts Download is ABSENT. That is the assertion with teeth: it is
  // the one button that must never appear on this tier, and the bar cannot know
  // the tier — so what is really being checked is that nothing here invents an
  // action the caller did not pass.
  describe("Elite's four steps", () => {
    it('1 — nothing held offers Request access, and nothing else', async () => {
      const { getByText, queryByText } = await render(
        <ActionBar actions={['grantAccess']} onAction={jest.fn()} />,
      );
      expect(getByText('Request access')).toBeTruthy();
      expect(queryByText('Download')).toBeNull();
    });

    // The position is the screen's job. A queued reader has nothing to tap, so the
    // bar contributes no height at all rather than an empty strip.
    it('2 — queued draws nothing, because a position is a status and not a button', async () => {
      const { queryByTestId, queryByText } = await render(
        <ActionBar actions={[]} onAction={jest.fn()} />,
      );
      expect(queryByTestId('action-bar')).toBeNull();
      expect(queryByText('Request access')).toBeNull();
    });

    it('3 — an offer draws Accept and Reject together', async () => {
      const { getByText, queryByText } = await render(
        <ActionBar actions={['acceptOffer', 'rejectOffer']} onAction={jest.fn()} />,
      );
      expect(getByText('Accept')).toBeTruthy();
      expect(getByText('Reject')).toBeTruthy();
      expect(queryByText('Download')).toBeNull();
    });

    it('3b — an answered offer cannot be answered twice', async () => {
      const onAction = jest.fn();
      const { getByTestId } = await render(
        <ActionBar actions={['acceptOffer', 'rejectOffer']} done="acceptOffer" onAction={onAction} />,
      );
      fireEvent.press(getByTestId('action-button-acceptOffer'));
      expect(onAction).not.toHaveBeenCalled();
    });

    it('4 — licence held offers read and revoke, and no download', async () => {
      const { getByText, queryByText } = await render(
        <ActionBar actions={['read', 'revokeLicence']} onAction={jest.fn()} />,
      );
      expect(getByText('Read')).toBeTruthy();
      expect(getByText('Revoke licence')).toBeTruthy();
      expect(queryByText('Download')).toBeNull();
    });
  });

  describe('pending', () => {
    it('marks only the tapped action as busy', async () => {
      const { getByTestId } = await render(
        <ActionBar actions={['read', 'download']} pending="read" onAction={jest.fn()} />,
      );
      expect(getByTestId('action-button-read').props.accessibilityState.busy).toBe(true);
      expect(getByTestId('action-button-download').props.accessibilityState.busy).toBe(false);
    });

    it('does not fire again while in flight', async () => {
      const onAction = jest.fn();
      const { getByTestId } = await render(
        <ActionBar actions={['read']} pending="read" onAction={onAction} />,
      );
      fireEvent.press(getByTestId('action-button-read'));
      expect(onAction).not.toHaveBeenCalled();
    });
  });
});
