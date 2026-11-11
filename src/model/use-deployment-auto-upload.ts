import { useEffect } from 'react';
import { api } from '../api';
import { deploymentAutoKey, deploymentRequest } from './deployment-api';
import type { DeploymentJob, DeploymentSavedFile } from './deployment-contracts';
import { enableDeploymentSaveNotifications } from './deployment-saves';
interface AutomaticPreference {
  serverId: string;
  credentialId?: string;
}
export function useDeploymentAutoUpload(
  root: string | undefined,
  generation: number | undefined,
  report: (message: string) => void,
) {
  useEffect(() => {
    if (!root) return;
    let active = true,
      loading = true,
      processing = false;
    let preference: AutomaticPreference | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let epoch = 0;
    const pending = new Map<string, DeploymentSavedFile>();
    const seen = new Map<string, number>();
    function schedule(delay = 500) {
      clearTimeout(timer);
      if (active && pending.size && preference) timer = setTimeout(() => void flush(), delay);
    }
    async function refresh() {
      const version = ++epoch;
      preference = null;
      enableDeploymentSaveNotifications(false);
      pending.clear();
      seen.clear();
      loading = true;
      try {
        const stored = await api.getSetting<AutomaticPreference>(deploymentAutoKey(root!));
        if (!active || epoch !== version) return;
        if (stored && typeof stored.serverId === 'string') {
          const packages = await api.packages();
          if (
            active &&
            epoch === version &&
            packages.some((item) => item.id === 'deployment' && item.enabled)
          )
            preference = stored;
        }
      } catch (error) {
        if (active && epoch === version)
          report(`SFTP automatic upload unavailable: ${String(error)}`);
      } finally {
        if (active && epoch === version) {
          loading = false;
          enableDeploymentSaveNotifications(!!preference);
          if (!preference) pending.clear();
          schedule();
        }
      }
    }
    async function flush() {
      if (processing || !preference || !active || !pending.size) return;
      processing = true;
      const version = epoch,
        target = preference;
      const batch = [...pending.values()].slice(0, 100);
      for (const file of batch) pending.delete(file.path);
      try {
        const result = await deploymentRequest<{
          busy?: boolean;
          conflicts?: number;
          message?: string;
          job?: DeploymentJob;
        }>(root!, 'upload.auto', { serverId: target.serverId, saved: batch }, target);
        if (!active || version !== epoch) return;
        if (result.busy) {
          for (const file of batch) if (!pending.has(file.path)) pending.set(file.path, file);
          return;
        }
        if (result.conflicts)
          report(`SFTP upload needs review: ${result.message ?? `${result.conflicts} conflicts`}`);
        if (result.job) {
          report(`SFTP upload started: ${result.job.serverName}`);
          let job = result.job;
          while (active && version === epoch && job.status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, 750));
            if (!active || version !== epoch) return;
            const next = await deploymentRequest<DeploymentJob | null>(root!, 'transfer.status');
            if (!next || next.id !== job.id) break;
            job = next;
          }
          if (active && version === epoch)
            report(
              job.status === 'completed'
                ? 'SFTP upload completed'
                : `SFTP upload ${job.status}; review Transfers`,
            );
        }
      } catch (error) {
        if (active && version === epoch)
          report(`SFTP upload failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        processing = false;
        schedule(1000);
      }
    }
    const saved = (event: Event) => {
      const file = (event as CustomEvent<DeploymentSavedFile>).detail;
      if (
        !file ||
        file.workspaceGeneration !== generation ||
        !file.path.startsWith(root + '/') ||
        (!loading && !preference)
      )
        return;
      const previous = pending.get(file.path);
      if (file.revision < (seen.get(file.path) ?? -1)) return;
      seen.set(file.path, file.revision);
      if (!previous || file.revision >= previous.revision) pending.set(file.path, file);
      if (pending.size > 5000) {
        pending.clear();
        report('SFTP save queue exceeded 5000 files. Use a reviewed manual upload.');
        return;
      }
      schedule();
    };
    const failed = (event: Event) => {
      if (preference) report(String((event as CustomEvent).detail));
    };
    void refresh();
    window.addEventListener('zwip:document-saved', saved);
    window.addEventListener('zwip:deployment-save-error', failed);
    window.addEventListener('zwip:deployment-changed', refresh);
    window.addEventListener('zwip:packages-changed', refresh);
    return () => {
      active = false;
      enableDeploymentSaveNotifications(false);
      epoch++;
      clearTimeout(timer);
      pending.clear();
      window.removeEventListener('zwip:document-saved', saved);
      window.removeEventListener('zwip:deployment-save-error', failed);
      window.removeEventListener('zwip:deployment-changed', refresh);
      window.removeEventListener('zwip:packages-changed', refresh);
    };
  }, [root, generation, report]);
}
