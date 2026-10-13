import { useRef, useState } from 'react';
import { updates, updateKinds } from '../content/updates';
import { Modal } from './Modal';

const dateLabel = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));

export function WhatsNew({ onClose }: { onClose(): void }) {
  const [selected, setSelected] = useState(updates[0]);
  const detail = useRef<HTMLElement>(null);

  return (
    <Modal title="What’s new" onClose={onClose} wide>
      <div className="updates-layout">
        <nav className="updates-history" aria-label="Update history">
          <p className="section-label">UPDATE HISTORY</p>
          {updates.map((update, index) => (
            <button
              key={update.id}
              aria-current={selected.id === update.id ? 'true' : undefined}
              aria-controls="update-details"
              onClick={() => {
                setSelected(update);
                detail.current?.scrollTo({ top: 0 });
              }}
            >
              <span className="update-meta">
                <span>v{update.version}</span>
                {index === 0 && <span className="update-latest">Latest</span>}
              </span>
              <strong>{update.title}</strong>
              <time dateTime={update.date}>{dateLabel(update.date)}</time>
            </button>
          ))}
        </nav>
        <article
          ref={detail}
          id="update-details"
          className="update-details"
          aria-labelledby="update-title"
          tabIndex={0}
        >
          <div className="update-meta">
            <span>Zwip · v{selected.version}</span>
            <time dateTime={selected.date}>{dateLabel(selected.date)}</time>
          </div>
          <h3 id="update-title">{selected.title}</h3>
          <p className="update-summary">{selected.summary}</p>
          {Object.entries(updateKinds).map(([kind, label]) => {
            const changes = selected.changes.filter((change) => change.type === kind);
            if (!changes.length) return null;
            return (
              <section className="update-group" key={kind} aria-label={label}>
                <h4 className={`update-kind update-kind-${kind}`}>{label}</h4>
                <ul>
                  {changes.map((change) => (
                    <li key={change.title}>
                      <strong>{change.title}</strong>
                      <p>{change.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </article>
      </div>
      <div className="modal-actions">
        <span>You can reopen this history from What’s new in the status bar.</span>
        <button className="primary" data-autofocus onClick={onClose}>
          Got it
        </button>
      </div>
    </Modal>
  );
}
