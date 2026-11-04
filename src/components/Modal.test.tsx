// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);

describe('modal Escape handling', () => {
  it('dismisses the dialog and prevents the native fullscreen fallback', () => {
    const close = vi.fn();
    render(
      <Modal title="Example" onClose={close}>
        <input aria-label="Query" />
      </Modal>,
    );
    expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('consumes Escape while a protected operation keeps the dialog open', () => {
    const close = vi.fn();
    render(
      <Modal title="Busy" onClose={close} dismissible={false}>
        Working…
      </Modal>,
    );
    expect(fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('lets a child consume Escape before dismissing the dialog', () => {
    const close = vi.fn();
    render(
      <Modal title="Example" onClose={close}>
        <input aria-label="Query" onKeyDown={(event) => event.preventDefault()} />
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('dismisses only the inner dialog when dialogs are nested', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Modal title="Outer" onClose={outer}>
        <Modal title="Inner" onClose={inner}>
          <input aria-label="Query" />
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });
});
