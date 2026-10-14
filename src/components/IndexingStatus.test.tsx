// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BuildContext } from '../contracts';
import { IndexingStatus } from './IndexingStatus';

const context = (id: string, state: BuildContext['state'], reason?: string): BuildContext => ({
  id,
  root: `/w/${id}`,
  reason,
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
  it('lists every module with its state and reason when clicked', () => {
    render(
      <IndexingStatus
        scannedFiles={null}
        root="/w"
        contexts={[
          context('ready-mod', 'ready'),
          context('queued-mod', 'loading', 'queued for background indexing'),
          context('broken-mod', 'failed', 'go list failed'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('progressbar', { name: 'Indexing build contexts' }));
    const rows = screen
      .getByRole('dialog', { name: 'Indexing progress per module' })
      .querySelectorAll('li');
    expect([...rows].map((row) => row.textContent)).toEqual([
      'Indexingqueued-modqueued for background indexing',
      'Failedbroken-modgo list failed',
      'Readyready-mod',
    ]);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows background package indexing once every module has loaded', () => {
    const view = render(
      <IndexingStatus
        scannedFiles={null}
        root="/w"
        contexts={[
          { ...context('a', 'ready'), indexed: 40, packages: 100 },
          { ...context('b', 'ready'), indexed: 10, packages: 20 },
        ]}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Indexing packages' }).textContent).toContain(
      'Indexing packages 50/120',
    );
    fireEvent.click(screen.getByRole('progressbar', { name: 'Indexing packages' }));
    expect(screen.getByText('40/100 packages')).toBeTruthy();
    view.rerender(
      <IndexingStatus
        scannedFiles={null}
        contexts={[{ ...context('a', 'ready'), indexed: 100, packages: 100 }]}
      />,
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
