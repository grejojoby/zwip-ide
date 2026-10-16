package cache

import (
	"context"
	"fmt"

	"golang.org/x/tools/gopls/internal/filecache"
)

// ZwipWorkspaceIndex restores the actual package artifacts used by upstream
// navigation. Missing artifacts are built and synchronously persisted before
// progress can advertise a complete checkpoint. Live compiler objects stay lazy.
func (s *Snapshot) ZwipWorkspaceIndex(ctx context.Context, ids []PackageID, force bool, progress func(int, bool) bool, restoreOnly ...bool) (bool, error) {
	handles, err := s.getPackageHandles(ctx, ids)
	if err != nil {
		return false, err
	}
	kinds := []string{xrefsKind, methodSetsKind, testsKind, diagnosticsKind}
	valid := func(id PackageID) bool {
		ph := handles[id]
		if ph == nil {
			return false
		}
		for _, kind := range kinds {
			if _, err := filecache.Get(kind, ph.key); err != nil {
				return false
			}
		}
		if ph.mp.PkgPath != "unsafe" {
			if _, err := filecache.Get(exportDataKind, ph.key); err != nil {
				return false
			}
		}
		return true
	}
	dependenciesReady := true
	for _, ph := range handles {
		if ph.mp.PkgPath != "unsafe" {
			if _, err := filecache.Get(exportDataKind, ph.key); err != nil {
				dependenciesReady = false
				break
			}
		}
	}
	var missing []PackageID
	for _, id := range ids {
		if force || !dependenciesReady || !valid(id) {
			missing = append(missing, id)
		}
	}
	restored := len(missing) == 0
	done := len(ids) - len(missing)
	if !progress(done, !restored) {
		return false, context.Canceled
	}
	if len(restoreOnly) > 0 && restoreOnly[0] && len(missing) > 0 {
		return false, fmt.Errorf("saved semantic artifacts are missing or changed; eager indexing is disabled")
	}
	for start := 0; start < len(missing); start += 16 {
		end := min(start+16, len(missing))
		batch := missing[start:end]
		packages, err := s.TypeCheck(ctx, batch...)
		if err != nil {
			return false, err
		}
		for i, pkg := range packages {
			// Upstream also stores these asynchronously. Waiting here makes a published
			// complete checkpoint independent of shutdown timing.
			storePackageResults(ctx, handles[batch[i]], pkg)
			if !valid(batch[i]) {
				return false, fmt.Errorf("cannot persist semantic artifacts for %s", batch[i])
			}
		}
		done += len(batch)
		if !progress(done, !restored) {
			return false, context.Canceled
		}
	}
	for _, ph := range handles {
		if ph.mp.PkgPath != "unsafe" {
			if _, err := filecache.Get(exportDataKind, ph.key); err != nil {
				return false, fmt.Errorf("dependency index unavailable for %s: %w", ph.mp.ID, err)
			}
		}
	}
	return restored, nil
}
