// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TargetChooser } from './TargetChooser';
import type { SourceLocation } from '../contracts';
const targets: SourceLocation[] = ['Reader', 'Writer'].map((name, index) => ({
  name,
  path: `/workspace/${name}.go`,
  range: { start: { line: index, character: 0 }, end: { line: index, character: 6 } },
  preview: `type ${name} interface {}`,
  contextIds: ['module'],
  relationship: 'implementation',
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
describe('navigation target chooser', () => {
  it('moves selection with arrow keys and opens the selected target on Enter', () => {
    const choose = vi.fn();
    render(<TargetChooser locations={targets} onChoose={choose} onClose={() => {}} />);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('type Writer interface {}')).toBeTruthy();
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(choose).toHaveBeenCalledWith(targets[1]);
  });
  it('handles Escape through native dialog cancel and restores previous focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const { unmount } = render(
      <TargetChooser locations={targets} onChoose={() => {}} onClose={close} />,
    );
    fireEvent(
      screen.getByRole('dialog'),
      new Event('cancel', { bubbles: false, cancelable: true }),
    );
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
