import type { DocumentSnapshot } from '../contracts';
import type { DeploymentSavedFile } from './deployment-contracts';
let enabled = false;
export function enableDeploymentSaveNotifications(value: boolean) {
  enabled = value;
}
export async function notifyDeploymentSave(saved: DocumentSnapshot): Promise<void> {
  if (!enabled || typeof window === 'undefined') return;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.content));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    window.dispatchEvent(
      new CustomEvent<DeploymentSavedFile>('zwip:document-saved', {
        detail: {
          path: saved.path,
          hash,
          revision: saved.revision,
          workspaceGeneration: saved.workspaceGeneration,
        },
      }),
    );
  } catch {
    window.dispatchEvent(
      new CustomEvent('zwip:deployment-save-error', {
        detail: 'Cannot verify the saved file; automatic upload was skipped.',
      }),
    );
  }
}
