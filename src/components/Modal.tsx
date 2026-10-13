import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        {dismissible && (
          <button className="icon-button" onClick={onClose} aria-label={`Close ${title}`}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
