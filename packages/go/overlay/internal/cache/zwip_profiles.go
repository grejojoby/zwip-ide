package cache

import (
	"context"
	"fmt"

	"golang.org/x/tools/gopls/internal/protocol"
)

// ZwipNewContextView creates one explicit module/profile view. Unlike NewView,
// it permits distinct folders with the same physical directory: each folder's
// options carry its own target and build tags. Name is the provider context ID.
// All file invalidation and snapshot ownership remain upstream's; distinct
// Folder pointers preserve these views when DidModifyFiles recomputes them.
func (s *Session) ZwipNewContextView(ctx context.Context, folder *Folder) (*View, *Snapshot, func(), error) {
	s.viewMu.Lock()
	defer s.viewMu.Unlock()
	if s.viewMap == nil {
		return nil, nil, nil, fmt.Errorf("session is shut down")
	}
	for _, view := range s.views {
		if view.folder.Name == folder.Name {
			return nil, nil, nil, fmt.Errorf("duplicate explicit context: %s", folder.Name)
		}
	}
	def, err := defineView(ctx, s, folder, nil)
	if err != nil {
		return nil, nil, nil, err
	}
	view, snapshot, release := s.createView(ctx, def)
	s.views = append(s.views, view)
	// The provider queries explicit views. Drop upstream's convenience URI
	// association cache so its invalidation helpers can reconsider all profiles.
	s.viewMap = make(map[protocol.DocumentURI]*View)
	return view, snapshot, release, nil
}
