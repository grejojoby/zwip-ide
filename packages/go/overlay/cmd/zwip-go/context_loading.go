package main

import (
	"context"
	"path/filepath"
	"sync"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/gopls/internal/settings"
)

type contextInitialization struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	session  *cache.Session
	goBinary string
	queue    []int // protected by worker.mu
}

type workspaceStatus struct {
	Generation int64          `json:"generation"`
	Contexts   []buildContext `json:"contexts"`
}

func (w *worker) status() workspaceStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return workspaceStatus{w.generation, append([]buildContext(nil), w.contexts...)}
}

// Requests promote their module ahead of queued background work. The two
// currently running loads finish normally; no duplicate views or servers arise.
func (w *worker) prioritizeContextLocked(path string) {
	loading := w.initialization
	if loading == nil {
		return
	}
	best, longest := -1, -1
	for index, candidate := range loading.queue {
		c := w.contexts[candidate]
		root := c.Root
		preferDefault := best >= 0 && len(root) == longest && c.ProfileID == "" && w.contexts[loading.queue[best]].ProfileID != ""
		if within(root, path) && (len(root) > longest || preferDefault) {
			best, longest = index, len(root)
		}
	}
	if best > 0 {
		item := loading.queue[best]
		copy(loading.queue[1:best+1], loading.queue[:best])
		loading.queue[0] = item
	}
}

func (w *worker) prioritizeContextIDLocked(id string) {
	loading := w.initialization
	if loading == nil {
		return
	}
	for index, candidate := range loading.queue {
		if w.contexts[candidate].ID == id {
			copy(loading.queue[1:index+1], loading.queue[:index])
			loading.queue[0] = candidate
			return
		}
	}
}

func (w *worker) loadContexts(loading *contextInitialization) {
	defer close(loading.done)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				w.mu.Lock()
				if loading.ctx.Err() != nil || w.initialization != loading || len(loading.queue) == 0 {
					w.mu.Unlock()
					return
				}
				index := loading.queue[0]
				loading.queue = loading.queue[1:]
				c := w.contexts[index]
				w.contexts[index].Reason = "background indexing in progress"
				w.mu.Unlock()
				view, err := loadGoContext(loading.ctx, loading.session, c, loading.goBinary)
				w.mu.Lock()
				if w.initialization == loading {
					if view != nil {
						w.views[c.ID] = view
					}
					if err != nil {
						w.contexts[index].State, w.contexts[index].Reason = "failed", err.Error()
					} else {
						w.contexts[index].State, w.contexts[index].Reason = "ready", ""
					}
				}
				w.mu.Unlock()
			}
		}()
	}
	workers.Wait()
}

func loadGoContext(ctx context.Context, session *cache.Session, c buildContext, goBinary string) (*cache.View, error) {
	options := settings.DefaultOptions()
	options.Env = map[string]string{"GOWORK": contextGoWork(c), "GOTOOLCHAIN": "local", "GOROOT": filepath.Dir(filepath.Dir(goBinary))}
	for key, value := range profileEnvironment(c) {
		options.Env[key] = value
	}
	// Only configured profiles are in scope; opening an excluded file must not
	// silently invent a target or widen the advertised context coverage.
	options.ZeroConfig = false
	options.DirectoryFilters = []string{"-**/node_modules", "-**/.git", "-**/.claude", "-**/vendor"}
	options.BuildFlags = contextBuildFlags(c)
	if options.BuildFlags[0] == "-mod=vendor" {
		options.ImportsSource = settings.ImportsSourceGoimports
	}
	uri := protocol.URIFromPath(c.Root)
	env, err := cache.FetchGoEnv(ctx, uri, options)
	if err != nil {
		return nil, err
	}
	view, snapshot, release, err := session.ZwipNewContextView(ctx, &cache.Folder{Dir: uri, Name: c.ID, Options: options, Env: *env})
	if err != nil {
		return nil, err
	}
	defer release()
	snapshot.AwaitInitialized(ctx)
	if err := ctx.Err(); err != nil {
		return view, err
	}
	if err := snapshot.InitializationError(); err != nil {
		return view, err.MainError
	}
	return view, nil
}
