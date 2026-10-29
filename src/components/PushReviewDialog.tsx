import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PushPlan } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
import { PushOverview } from './PushOverview';
import { useGitActivity } from './GitActivity';

/** Every entry point reviews a fingerprinted plan before the user can push. */
export function PushReviewDialog({
  onClose,
  onPushed,
}: {
  onClose(): void;
  onPushed(message: string): void;
}) {
  const gitActivity = useGitActivity();
  const [plan, setPlan] = useState<PushPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    api
      .pushPlan()
      .then((next) => {
        if (active) {
          setPlan(next);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(asError(e).message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);
  function push() {
    if (!plan || submitting.current || loading || gitActivity.busy || !plan.commits.length) return;
    submitting.current = true;
    const started = gitActivity.run({
      pending: `Pushing '${plan.branch}'…`,
      success: `Branch '${plan.branch}' pushed.`,
      failure: `Could not push '${plan.branch}'.`,
      task: () => api.push(plan.fingerprint),
      onSuccess: (message) => onPushed(message || 'Push completed.'),
    });
    if (started) onClose();
    else submitting.current = false;
  }
  return (
    <Modal title="Push Commits" onClose={onClose} wide>
      {loading ? (
        <p className="empty-note" role="status">
          Loading outgoing changes…
        </p>
      ) : (
        plan && <PushOverview key={plan.fingerprint} plan={plan} onEdit={onClose} />
      )}
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span>Review the commits and files to be pushed.</span>
        {error && (
          <button
            disabled={loading || gitActivity.busy}
            onClick={() => {
              setLoading(true);
              setError('');
              setPlan(null);
              setRevision((value) => value + 1);
            }}
          >
            Refresh review
          </button>
        )}
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={loading || gitActivity.busy || !plan?.commits.length}
          onClick={() => void push()}
        >
          {plan
            ? `Push ${plan.commits.length} commit${plan.commits.length === 1 ? '' : 's'}`
            : 'Push'}
        </button>
      </div>
    </Modal>
  );
}
