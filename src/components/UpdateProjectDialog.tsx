import { useCallback, useEffect, useRef, useState } from 'react';
import { api, request } from '../api';
import type { GitMutation, GitSnapshot } from '../contracts';
import { asError } from '../model/document-session';
import { branchUpdateNotice, useGitActivity } from './GitActivity';
import { Modal } from './Modal';

type Strategy = 'merge' | 'rebase';
interface Preference {
  strategy: Strategy;
  skipDialog: boolean;
}
const preferenceKey = 'git.updateProject';
export function UpdateProjectDialog({
  onClose,
  onUpdated,
  showOptions = false,
}: {
  onClose(): void;
  onUpdated(): void;
  showOptions?: boolean;
}) {
  const { run, busy } = useGitActivity();
  const callbacks = useRef({ onClose, onUpdated });
  callbacks.current = { onClose, onUpdated };
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [strategy, setStrategy] = useState<Strategy>('merge');
  const [skipDialog, setSkipDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const start = useCallback(
    (reviewed: GitSnapshot, preference: Preference) => {
      const started = run({
        pending: `Updating '${reviewed.branch}'…`,
        success: branchUpdateNotice,
        failure: `Could not update '${reviewed.branch}'.`,
        task: () =>
          request<GitMutation>('git.pull', {
            fingerprint: reviewed.fingerprint,
            strategy: preference.strategy,
          }).finally(() => callbacks.current.onUpdated()),
      });
      if (started) {
        void api.setSetting(preferenceKey, preference).catch(() => undefined);
        callbacks.current.onClose();
      }
    },
    [run],
  );
  useEffect(() => {
    let active = true;
    void Promise.all([api.gitStatus(), api.getSetting<Preference>(preferenceKey).catch(() => null)])
      .then(([reviewed, stored]) => {
        if (!active) return;
        const preference: Preference = {
          strategy: stored?.strategy === 'rebase' ? 'rebase' : 'merge',
          skipDialog: stored?.skipDialog === true,
        };
        setSnapshot(reviewed);
        setStrategy(preference.strategy);
        setSkipDialog(preference.skipDialog);
        setLoading(false);
        if (preference.skipDialog && !showOptions) start(reviewed, preference);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(asError(reason).message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [revision, showOptions, start]);
  return (
    <Modal title="Update Project" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (snapshot && !loading && !busy) start(snapshot, { strategy, skipDialog });
        }}
      >
        <div className="update-project-body">
          {loading ? (
            <p role="status">Loading current branch…</p>
          ) : (
            snapshot && (
              <>
                <p className="update-project-branch">
                  Update <strong>{snapshot.branch}</strong> from its remote upstream
                </p>
                <fieldset disabled={busy}>
                  <legend>Update method</legend>
                  <label>
                    <input
                      type="radio"
                      name="strategy"
                      value="merge"
                      checked={strategy === 'merge'}
                      onChange={() => setStrategy('merge')}
                      autoFocus={strategy === 'merge'}
                    />
                    Merge incoming changes into the current branch
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="strategy"
                      value="rebase"
                      checked={strategy === 'rebase'}
                      autoFocus={strategy === 'rebase'}
                      onChange={() => setStrategy('rebase')}
                    />
                    Rebase the current branch on top of incoming changes
                  </label>
                </fieldset>
              </>
            )
          )}
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions update-project-actions">
          <label title="Open Update Project from Find Action to change these options later.">
            <input
              type="checkbox"
              checked={skipDialog}
              onChange={(event) => setSkipDialog(event.target.checked)}
              disabled={loading || busy}
            />
            Don't show again
          </label>
          {error && (
            <button
              type="button"
              onClick={() => {
                setError('');
                setLoading(true);
                setRevision((value) => value + 1);
              }}
            >
              Retry
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={loading || busy || !snapshot}>
            OK
          </button>
        </div>
      </form>
    </Modal>
  );
}
