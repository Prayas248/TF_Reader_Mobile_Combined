// src/components/ContentCard/ContentCard.test.tsx
// ContentCard renders one publication as a row: thumbnail, a meta row
// (publisher, format chip, access badge), title, author line. It is the card
// used in the listing beneath the subject chips.
//
// `variant="cover"` is the tile/carousel shape. One was built and removed years
// before this — nothing rendered it, and CONVENTIONS §10 forbids a variant
// without a caller. CatalogueScreen's first-shelf carousel is now that caller,
// so it is back, following §7's normal path. It drops the action slot and
// chevron to stay compact; everything else below (title clamp, meta row,
// author line, loading skeleton) applies to it identically to `row`.
//
// Every awkward case below is real: no fixture publication carries a
// `thumbnailUrl`, `item_ab6` has zero authors, and `accessTier` is absent
// everywhere (CLAUDE.md Q-D).
//
// `await render(...)` — IT IS ASYNC IN THIS TOOLKIT, AND SILENT IF YOU FORGET.
// @testing-library/react-native 14 returns a Promise from `render` (it drives
// React 19's concurrent renderer through `test-renderer`). Forgetting the await
// does not throw: you get a Promise, so every destructured query is `undefined`
// ("queryByText is not a function") and `screen` reports "`render` function has
// not been called" — neither of which points at the missing await.
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ActionButton } from '@components/ActionButton';
import { ContentCard } from '@components/ContentCard';

describe('ContentCard content', () => {
  it('renders the title and the publisher line', async () => {
    await render(
      <ContentCard
        title="A review of renewable energy integration in smart grids"
        publisher="Renewable Energy"
      />,
    );

    expect(
      screen.getByText('A review of renewable energy integration in smart grids'),
    ).toBeTruthy();
    expect(screen.getByText('Renewable Energy')).toBeTruthy();
  });

  // A publication may legitimately have no publisher, and an empty grey line
  // where one should be reads as a loading bug.
  it('omits the publisher line entirely when no publisher is given', async () => {
    await render(<ContentCard title="Ethnographies of Waiting" />);

    expect(screen.queryByTestId('content-card-publisher')).toBeNull();
  });

  // `Publication.authors` is a real array that is sometimes empty (`item_ab6`
  // in the fixtures has zero) — the screen passes `undefined` for that case,
  // and an empty grey line where a name should be reads as a bug the same way
  // a blank publisher line would.
  it('renders the author line when given one, omits it entirely otherwise', async () => {
    await render(<ContentCard title="Rights for Robots" authors="Joshua C. Gellers" />);
    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
  });

  it('omits the author line entirely when none is given', async () => {
    await render(<ContentCard title="Ethnographies of Waiting" />);

    expect(screen.queryByTestId('content-card-authors')).toBeNull();
  });

  it('renders the cover when an image url is given', async () => {
    await render(<ContentCard title="Rights for Robots" imageUrl="https://cdn.tf/a.jpg" />);

    // expo-image normalizes a single `{ uri }` source into a one-element array
    // on the rendered host node — unlike RN's Image, which passes it through
    // unchanged.
    expect(screen.getByTestId('content-card-image').props.source).toEqual([
      { uri: 'https://cdn.tf/a.jpg', cacheKey: 'https://cdn.tf/a.jpg' },
    ]);
  });

  // types.ts: "a publication with no cover renders a placeholder, it is not an
  // error". No fixture supplies thumbnailUrl, so this path is the common case
  // today — it must not collapse the row to zero height or crash.
  it('renders a placeholder instead of an image when no image url is given', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-image')).toBeNull();
    expect(screen.getByTestId('content-card-placeholder')).toBeTruthy();
  });

  // A load failure used to leave the same bare grey well "no cover on file"
  // renders — indistinguishable from a title that genuinely has none. The
  // Image component itself fires `onError`, not a network layer this file
  // could intercept earlier, so the fallback has to react to it here.
  it('swaps to the placeholder when the cover image fails to load', async () => {
    await render(<ContentCard title="Rights for Robots" imageUrl="https://cdn.tf/broken.jpg" />);

    expect(screen.getByTestId('content-card-image')).toBeTruthy();

    await fireEvent(screen.getByTestId('content-card-image'), 'error', {
      nativeEvent: { error: 'could not load image' },
    });

    expect(screen.queryByTestId('content-card-image')).toBeNull();
    expect(screen.getByTestId('content-card-placeholder')).toBeTruthy();
  });

  // A3 — the row carries title, publisher, FILE FORMAT and access badge. The
  // format was the one of those four never wired: there was no prop to pass it
  // to, so the card could not have shown it even with the data in hand.
  it('renders the file format it is given', async () => {
    await render(<ContentCard title="Rights for Robots" format="PDF" />);

    expect(screen.getByTestId('content-card-format')).toBeTruthy();
    expect(screen.getByText('PDF')).toBeTruthy();
  });

  // Real, already-derived data (never guessed from the tier or the id — see
  // the file header) drives this, not a decision the card makes: AUDIO means
  // no cover art to look at either way.
  it('draws a play overlay on the thumbnail only for the AUDIO format', async () => {
    await render(<ContentCard title="Doctor Dolittle" format="AUDIO" />);

    expect(screen.getByTestId('content-card-play-overlay')).toBeTruthy();
  });

  it('draws no play overlay for a non-audio format', async () => {
    await render(<ContentCard title="Rights for Robots" format="PDF" />);

    expect(screen.queryByTestId('content-card-play-overlay')).toBeNull();
  });

  it('draws no play overlay when there is no format at all', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-play-overlay')).toBeNull();
  });

  // A `subscribe` title has no file at all, so `format` is absent rather than
  // unknown — a format line there would label something that does not exist.
  it('omits the format line when the publication has no file', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-format')).toBeNull();
  });

  it('keeps a long title to a fixed number of lines rather than pushing the row open', async () => {
    await render(
      <ContentCard
        title={'Environmental Policy and Air Pollution in China: Governance and Strategy'.repeat(3)}
      />,
    );

    expect(screen.getByTestId('content-card-title').props.numberOfLines).toBeGreaterThan(0);
  });

});

describe('ContentCard access badge', () => {
  // The card must never decide what the badge says. Design Spec §5.1: the UI
  // never calculates access rights — the screen resolves access and passes the
  // rendered badge (Akriti's AccessTierBadge) straight in. That is also why this
  // file's component imports nothing from @model: it takes strings, not a
  // Publication, so it cannot reach for a field it should not interpret.
  it('renders whatever badge it is handed', async () => {
    await render(
      <ContentCard title="CRISPR-Cas9 technologies" badge={<Text>Open Access</Text>} />,
    );

    expect(screen.getByText('Open Access')).toBeTruthy();
  });

  it('shows no badge area when given no badge', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-badge')).toBeNull();
  });
});

describe('ContentCard press behaviour', () => {
  it('reports a press through onPress', async () => {
    const onPress = jest.fn();
    await render(<ContentCard title="Rights for Robots" onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Rights for Robots' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // A skeleton has nothing behind it yet. Letting it navigate would open a
  // detail screen for a publication the card does not know the identity of.
  it('does not report a press while loading', async () => {
    const onPress = jest.fn();
    await render(<ContentCard state="loading" title="Rights for Robots" onPress={onPress} />);

    fireEvent.press(screen.getByTestId('content-card'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('is not announced as a button when it has no press handler', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  // The chevron is the row's "this opens something" affordance. Drawing one on a
  // row that does nothing is a lie to the user.
  it('draws the chevron only when the row can be opened', async () => {
    const { rerender } = await render(<ContentCard title="Rights for Robots" />);
    expect(screen.queryByTestId('content-card-chevron')).toBeNull();

    await rerender(<ContentCard title="Rights for Robots" onPress={jest.fn()} />);
    expect(screen.getByTestId('content-card-chevron')).toBeTruthy();
  });
});

describe('ContentCard cover variant', () => {
  it('renders title, publisher and badge, with an image', async () => {
    await render(
      <ContentCard
        variant="cover"
        title="Rights for Robots"
        publisher="Routledge"
        imageUrl="https://cdn.tf/a.jpg"
        badge={<Text>Open Access</Text>}
      />,
    );

    expect(screen.getByText('Rights for Robots')).toBeTruthy();
    expect(screen.getByText('Routledge')).toBeTruthy();
    expect(screen.getByText('Open Access')).toBeTruthy();
    // expo-image normalizes a single `{ uri }` source into a one-element array
    // on the rendered host node — unlike RN's Image, which passes it through
    // unchanged. `cacheKey` strips the querystring so a re-signed URL for the
    // same cover keeps hitting the same cache entry — see the component's
    // own note.
    expect(screen.getByTestId('content-card-image').props.source).toEqual([
      { uri: 'https://cdn.tf/a.jpg', cacheKey: 'https://cdn.tf/a.jpg' },
    ]);
  });

  it('renders a placeholder instead of an image when no image url is given', async () => {
    await render(<ContentCard variant="cover" title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-image')).toBeNull();
    expect(screen.getByTestId('content-card-placeholder')).toBeTruthy();
  });

  it('swaps to the placeholder when the cover image fails to load', async () => {
    await render(
      <ContentCard variant="cover" title="Rights for Robots" imageUrl="https://cdn.tf/broken.jpg" />,
    );

    await fireEvent(screen.getByTestId('content-card-image'), 'error', {
      nativeEvent: { error: 'could not load image' },
    });

    expect(screen.queryByTestId('content-card-image')).toBeNull();
    expect(screen.getByTestId('content-card-placeholder')).toBeTruthy();
  });

  // A carousel tile still shows the file format (as a chip, in the meta row —
  // see `MetaRow`), but stays compact by dropping the action slot, and —
  // since it never draws a chevron — it can still be pressable without one.
  it('renders the format chip but omits the action slot and chevron', async () => {
    await render(
      <ContentCard
        variant="cover"
        title="Rights for Robots"
        format="PDF"
        action={<Text>Request access</Text>}
        onPress={() => {}}
      />,
    );

    expect(screen.getByTestId('content-card-format')).toBeTruthy();
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
    expect(screen.queryByTestId('content-card-chevron')).toBeNull();
  });

  // The credit line under the title — real data (`Publication.authors`) is
  // sometimes an empty array, so the screen passes `undefined` rather than an
  // empty string, and that must render no line at all, not a blank one.
  it('renders the author line when given one, omits it entirely otherwise', async () => {
    const withAuthor = await render(
      <ContentCard variant="cover" title="Rights for Robots" authors="Joshua C. Gellers" />,
    );
    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
    await withAuthor.unmount();

    const withoutAuthor = await render(
      <ContentCard variant="cover" title="Ethnographies of Waiting" />,
    );
    expect(screen.queryByTestId('content-card-authors')).toBeNull();
    await withoutAuthor.unmount();
  });

  it('reports a press through onPress, same as the row variant', async () => {
    const onPress = jest.fn();
    await render(<ContentCard variant="cover" title="Rights for Robots" onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Rights for Robots' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders a skeleton while loading, with no title text', async () => {
    await render(<ContentCard variant="cover" state="loading" title="Rights for Robots" />);

    expect(screen.queryByText('Rights for Robots')).toBeNull();
    expect(screen.getByTestId('content-card-skeleton')).toBeTruthy();
  });

  // Side-by-side carousel tiles, unlike a stacked list, make a missing line
  // read as a bug rather than ordinary variation — so the meta row and author
  // line reserve their height whether or not they have anything to show, and
  // that height must not depend on whether the content is there.
  it('keeps the meta-row and author slots the same height with or without their content', async () => {
    const withContent = await render(
      <ContentCard
        variant="cover"
        title="Rights for Robots"
        publisher="Routledge"
        authors="Joshua C. Gellers"
        badge={<Text>Open Access</Text>}
      />,
    );
    const metaHeightWith = screen.getByTestId('content-card-meta-slot').props.style.height;
    const authorHeightWith = screen.getByTestId('content-card-author-slot').props.style.height;
    await withContent.unmount();

    const withoutContent = await render(<ContentCard variant="cover" title="Rights for Robots" />);
    expect(screen.getByTestId('content-card-meta-slot').props.style.height).toBe(metaHeightWith);
    expect(screen.getByTestId('content-card-author-slot').props.style.height).toBe(
      authorHeightWith,
    );
    await withoutContent.unmount();
  });
});

describe('ContentCard loading state', () => {
  // §6: "Skeleton at the real content's dimensions so nothing jumps." The text
  // must be absent, not rendered transparent — a screen reader would read it.
  it('renders no title text while loading', async () => {
    await render(<ContentCard state="loading" title="Rights for Robots" />);

    expect(screen.queryByText('Rights for Robots')).toBeNull();
    expect(screen.getByTestId('content-card-skeleton')).toBeTruthy();
  });

  it('shows no badge while loading, since access is not resolved yet', async () => {
    await render(
      <ContentCard state="loading" title="Rights for Robots" badge={<Text>Open Access</Text>} />,
    );

    expect(screen.queryByText('Open Access')).toBeNull();
  });
});

// D12 — the row's resolved access action. A slot, like `badge`: the card renders
// whatever node it is handed and decides nothing about entitlement itself.
describe('ContentCard action slot', () => {
  it('renders no action area when none is supplied', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  it('renders the action it is handed', async () => {
    await render(<ContentCard title="Rights for Robots" action={<Text>Request access</Text>} />);

    expect(screen.getByTestId('content-card-action')).toBeTruthy();
    expect(screen.getByText('Request access')).toBeTruthy();
  });

  // The skeleton stands in for a publication whose entitlement is not known yet,
  // so it must not offer an action — same rule the badge already follows.
  it('renders no action while the row is a skeleton', async () => {
    await render(
      <ContentCard state="loading" title="Rights for Robots" action={<Text>Request access</Text>} />,
    );

    expect(screen.queryByTestId('content-card-action')).toBeNull();
    expect(screen.queryByText('Request access')).toBeNull();
  });

  // The reason the slot can hold a button at all: a nested Pressable claims its
  // own touch, and both stay in the accessibility tree. A default-accessible
  // Pressable CAN collapse its children into one element (see SignInScreen's
  // note), which would have hidden the queue button entirely — so this is the
  // regression test for that, not a restatement of RN behaviour.
  it('keeps a nested pressable action reachable, and separate from the row', async () => {
    const onPress = jest.fn();
    const onAction = jest.fn();
    await render(
      <ContentCard
        title="Rights for Robots"
        onPress={onPress}
        action={<ActionButton action="grantAccess" onPress={onAction} />}
      />,
    );

    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rights for Robots' })).toBeTruthy();

    fireEvent.press(screen.getByTestId('action-button-grantAccess'));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('ContentCard progress bar', () => {
  it('draws no bar when no fraction is supplied', async () => {
    await render(<ContentCard title="Rights for Robots" />);

    expect(screen.queryByTestId('content-card-progress-track')).toBeNull();
  });

  it('draws the fill at the given fraction, never a guessed one', async () => {
    await render(<ContentCard title="Rights for Robots" progress={3 / 7} />);

    expect(screen.getByTestId('content-card-progress-track')).toBeTruthy();
    expect(screen.getByTestId('content-card-progress-fill').props.style[1].width).toBe('43%');
  });
});
