// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BuildContext } from '../contracts';
import { IndexingStatus } from './IndexingStatus';

const context = (id: string, state: BuildContext['state']): BuildContext => ({
  id,
  root: '/w',
  language: 'go',
  configPath: `/w/${id}`,
  state,
});
afterEach(cleanup);

describe('IndexingStatus', () => {
  it('shows the file count while scanning', () => {
    render(<IndexingStatus scannedFiles={1234} contexts={[]} />);
    expect(screen.getByText(/Indexing files… 1,234/)).toBeTruthy();
  });
  it('shows context progress while any context is loading', () => {
    render(
      <IndexingStatus
        scannedFiles={null}
        contexts={[context('a', 'ready'), context('b', 'loading'), context('c', 'unavailable')]}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Indexing build contexts' })).toBeTruthy();
    expect(screen.getByText('Indexing 2/3')).toBeTruthy();
  });
  it('is hidden once nothing is indexing', () => {
    const { container } = render(
      <IndexingStatus scannedFiles={null} contexts={[context('a', 'ready')]} />,
    );
    expect(container.textContent).toBe('');
  });
});
