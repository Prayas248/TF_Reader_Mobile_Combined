import { fireEvent, render } from '@testing-library/react-native';

import { ACTION_IDS, type ActionId } from '@model/types';

import ActionButton from './ActionButton';

// `render` is ASYNC in @testing-library/react-native v14 — forget the await and
// you get "getByText is not a function". Same note as AccessTierBadge.test.tsx.

// Labels are written out rather than imported from the component, so a wrong
// label fails the test instead of agreeing with itself.
const LABELS: Record<ActionId, string> = {
  read: 'Read',
  play: 'Play',
  download: 'Download',
  grantAccess: 'Request access',
  acceptOffer: 'Accept',
  rejectOffer: 'Reject',
  revokeLicence: 'Revoke licence',
  subscribe: 'Subscribe',
  signIn: 'Sign in',
};

describe('ActionButton', () => {
  // Iterates the contract rather than a list of eight, so a ninth action fails
  // here until it has a label.
  ACTION_IDS.forEach((action) => {
    it(`renders the ${action} label`, async () => {
      const { getByText } = await render(<ActionButton action={action} />);
      expect(getByText(LABELS[action])).toBeTruthy();
    });

    it(`fires onPress for ${action}`, async () => {
      const onPress = jest.fn();
      const { getByTestId } = await render(<ActionButton action={action} onPress={onPress} />);
      fireEvent.press(getByTestId(`action-button-${action}`));
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('skeleton', () => {
    it('renders a placeholder and no label', async () => {
      const { getByTestId, queryByText } = await render(
        <ActionButton action="read" state="skeleton" />,
      );
      expect(getByTestId('action-button-skeleton')).toBeTruthy();
      expect(queryByText('Read')).toBeNull();
    });
  });

  // `done` renders a button inert. Since the 16 Aug flow change no action defines
  // a `doneLabel` — `addToQueue` was the only one that ever did — so the label
  // always falls through. The inertness is the part with a job left.
  describe('done', () => {
    it('cannot be tapped again, so an offer cannot be accepted twice', async () => {
      const onPress = jest.fn();
      const { getByTestId } = await render(
        <ActionButton action="acceptOffer" state="done" onPress={onPress} />,
      );
      fireEvent.press(getByTestId('action-button-acceptOffer'));
      expect(onPress).not.toHaveBeenCalled();
    });

    // Iterates the contract, so the day something DOES define a `doneLabel` this
    // fails and the assertion above has to be split rather than quietly widened.
    ACTION_IDS.forEach((action) => {
      it(`falls back to the normal label for ${action}, which has no spent form`, async () => {
        const { getByText } = await render(<ActionButton action={action} state="done" />);
        expect(getByText(LABELS[action])).toBeTruthy();
      });
    });
  });

  describe('loading', () => {
    it('keeps the label and shows a spinner', async () => {
      const { getByText, getByTestId } = await render(
        <ActionButton action="read" state="loading" />,
      );
      expect(getByText('Read')).toBeTruthy();
      expect(getByTestId('action-button-spinner')).toBeTruthy();
    });

    // The whole reason this state exists: index.html §Access — "a button with no
    // busy state gets tapped four times", and each tap is a licence call.
    it('swallows further taps while a licence call is in flight', async () => {
      const onPress = jest.fn();
      const { getByTestId } = await render(
        <ActionButton action="read" state="loading" onPress={onPress} />,
      );
      fireEvent.press(getByTestId('action-button-read'));
      fireEvent.press(getByTestId('action-button-read'));
      expect(onPress).not.toHaveBeenCalled();
    });
  });

  describe('disabled', () => {
    it('does not fire onPress', async () => {
      const onPress = jest.fn();
      const { getByTestId } = await render(
        <ActionButton action="read" disabled onPress={onPress} />,
      );
      fireEvent.press(getByTestId('action-button-read'));
      expect(onPress).not.toHaveBeenCalled();
    });

    it('is announced as disabled', async () => {
      const { getByTestId } = await render(<ActionButton action="read" disabled />);
      expect(getByTestId('action-button-read').props.accessibilityState.disabled).toBe(true);
    });
  });

  // `revokeLicence` carries the longest label in the vocabulary now that
  // "Add me to queue" is gone, so it is the one that would grow the bar first.
  it('truncates rather than wrapping, so a long label cannot grow the bar', async () => {
    const { getByText } = await render(<ActionButton action="revokeLicence" />);
    expect(getByText('Revoke licence').props.numberOfLines).toBe(1);
  });
});
