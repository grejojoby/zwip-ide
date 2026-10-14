package main

import (
	"context"
	"fmt"
	"go/version"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"golang.org/x/mod/modfile"
	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/filecache"
	"golang.org/x/tools/gopls/internal/protocol"
)

const defaultGo = "/Users/grejo.j/.gvm/gos/go1.25.5/bin/go"

type worker struct {
	mu             sync.Mutex
	session        *cache.Session
	root           string
	contexts       []buildContext
	generation     int64
	documents      map[string]documentUpdate
	epoch          atomic.Uint64
	tools          *toolService
	protection     *sumProtection
	initialization *contextInitialization
	views          map[string]*cache.View
	// Set by "workspace.index": type-check every package of each ready context so gopls
	// fills its persistent cache up front instead of on first use.
	warm bool
}

func newWorker() *worker {
	return &worker{documents: make(map[string]documentUpdate), tools: newToolService()}
}

func canonical(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("absolute path required: %s", path)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		// Unsaved new source files may not exist yet, but their nearest existing
		// parent must still be canonicalized so symlinks cannot escape the root.
		if _, statErr := os.Lstat(path); os.IsNotExist(statErr) && filepath.Dir(path) != path {
			parent, parentErr := canonical(filepath.Dir(path))
			if parentErr != nil {
				return "", parentErr
			}
			return filepath.Join(parent, filepath.Base(path)), nil
		}
		return "", err
	}
	return filepath.Clean(real), nil
}

func within(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (w *worker) close() {
	w.epoch.Add(1)
	w.stopTools()
	w.mu.Lock()
	session := w.session
	w.session = nil
	initialization := w.initialization
	w.initialization = nil
	if initialization != nil {
		initialization.cancel()
	}
	w.views = nil
	protection := w.protection
	w.protection = nil
	w.mu.Unlock()
	if initialization != nil {
		<-initialization.done
	}
	if session != nil {
		session.Shutdown(context.Background())
	}
	if protection != nil {
		_ = os.RemoveAll(protection.dir)
	}
}

func (w *worker) initialize(ctx context.Context, p initializeParams) ([]buildContext, error) {
	if _, err := w.initializeAsync(ctx, p); err != nil {
		return nil, err
	}
	w.mu.Lock()
	loading := w.initialization
	w.mu.Unlock()
	<-loading.done
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]buildContext(nil), w.contexts...), nil
}

func (w *worker) initializeAsync(ctx context.Context, p initializeParams) ([]buildContext, error) {
	root, err := canonical(p.Root)
	if err != nil {
		return nil, err
	}
	contexts := make([]buildContext, 0, len(p.Contexts))
	ids, roots := map[string]bool{}, map[string]bool{}
	for _, c := range p.Contexts {
		if c.Language != "go" {
			continue
		}
		c.Root, err = canonical(c.Root)
		if err != nil {
			return nil, err
		}
		profileKey := c.Root + "\x00" + c.ProfileID
		if c.ID == "" || ids[c.ID] || roots[profileKey] {
			return nil, fmt.Errorf("duplicate or empty Go context: %s", c.ID)
		}
		c.profile, err = parseGoBuildSettings(c.Settings)
		if err != nil {
			return nil, fmt.Errorf("context %s: %w", c.ID, err)
		}
		if len(c.Settings) > 0 && c.ProfileID == "" {
			return nil, fmt.Errorf("context %s: custom settings require an explicit profileId", c.ID)
		}
		if !within(root, c.Root) {
			return nil, fmt.Errorf("Go context escapes workspace: %s", c.Root)
		}
		if _, err := os.Stat(filepath.Join(c.Root, "go.mod")); err != nil {
			return nil, fmt.Errorf("context %s: %w", c.ID, err)
		}
		ids[c.ID], roots[profileKey] = true, true
		c.ConfigPath = filepath.Join(c.Root, "go.mod")
		c.State = "loading"
		c.GoWork, err = discoverGoWork(root, c.Root)
		if err != nil {
			c.State, c.Reason = "failed", err.Error()
		}
		contexts = append(contexts, c)
	}
	if len(contexts) == 0 {
		return nil, fmt.Errorf("no Go module contexts supplied")
	}
	goBinary := os.Getenv("ZWIP_GO")
	if goBinary == "" {
		goBinary = defaultGo
	}
	if !filepath.IsAbs(goBinary) {
		return nil, fmt.Errorf("ZWIP_GO must be an absolute Go executable path")
	}
	if _, err := os.Stat(goBinary); err != nil {
		return nil, err
	}
	if err := validateGoProfileTargets(ctx, goBinary, contexts); err != nil {
		return nil, err
	}
	// A non-writable persistent cache can make upstream imported types fail
	// silently later. Detect that setup failure before advertising contexts.
	if _, err := filecache.Get("zwip-provider-probe", [32]byte{}); err != nil && err != filecache.ErrNotFound {
		return nil, fmt.Errorf("gopls cache unavailable; configure writable GOPLSCACHE: %w", err)
	}
	// gopls's command runner invokes go by name. Put only the explicitly
	// configured toolchain first; never discover or substitute another Go SDK.
	if err := os.Setenv("PATH", filepath.Dir(goBinary)+string(os.PathListSeparator)+os.Getenv("PATH")); err != nil {
		return nil, err
	}
	if err := os.Setenv("GOROOT", filepath.Dir(filepath.Dir(goBinary))); err != nil {
		return nil, err
	}
	protection, protectiveChanges, err := protectWorkspaceSums(contexts)
	if err != nil {
		return nil, err
	}
	w.close()
	w.mu.Lock()
	defer w.mu.Unlock()
	w.root, w.contexts, w.generation = root, contexts, p.Generation
	w.documents = make(map[string]documentUpdate)
	w.session = cache.NewSession(context.Background(), cache.New(nil))
	w.protection = protection
	if len(protectiveChanges) > 0 {
		if _, err := w.session.DidModifyFiles(ctx, protectiveChanges); err != nil {
			return nil, err
		}
	}
	w.views = make(map[string]*cache.View)
	loadCtx, cancel := context.WithCancel(ctx)
	loading := &contextInitialization{ctx: loadCtx, cancel: cancel, done: make(chan struct{}), session: w.session, goBinary: goBinary}
	for i := range w.contexts {
		if w.contexts[i].State != "failed" {
			w.contexts[i].Reason = "queued for background indexing"
			loading.queue = append(loading.queue, i)
		}
	}
	w.initialization = loading
	go w.loadContexts(loading)

	return append([]buildContext(nil), w.contexts...), nil
}

func moduleBuildFlags(root string) []string {
	// Preserve automatic vendor mode while preventing navigation from updating
	// project module files. An explicit GOFLAGS mode takes precedence over the
	// default; requests for writable module mode are constrained to readonly.
	mode := ""
	for _, flag := range strings.Fields(os.Getenv("GOFLAGS")) {
		if flag == "-mod=vendor" || flag == "-mod=readonly" || flag == "-mod=mod" {
			mode = flag
		}
	}
	if mode == "-mod=vendor" {
		return []string{mode}
	}
	if mode != "" {
		return []string{"-mod=readonly"}
	}
	content, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err == nil {
		manifest, err := modfile.ParseLax("go.mod", content, nil)
		if err == nil && manifest.Go != nil && version.Compare("go"+manifest.Go.Version, "go1.14") >= 0 {
			if info, err := os.Stat(filepath.Join(root, "vendor")); err == nil && info.IsDir() {
				return []string{"-mod=vendor"}
			}
		}
	}
	return []string{"-mod=readonly"}
}

func (w *worker) update(ctx context.Context, p documentUpdate) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session == nil {
		return fmt.Errorf("provider is not initialized")
	}
	path, err := canonical(p.Path)
	if err != nil {
		return err
	}
	if !within(w.root, path) {
		return fmt.Errorf("document is outside the workspace")
	}
	w.prioritizeContextLocked(path)
	previous, exists := w.documents[path]
	if exists && p.Revision <= previous.Revision {
		if p.Revision == previous.Revision && p.Content == previous.Content {
			return nil
		}
		return fmt.Errorf("document revision must increase")
	}
	if p.Revision <= 0 {
		return fmt.Errorf("document revision must be positive")
	}
	action := file.Open
	if exists {
		action = file.Change
	}
	_, err = w.session.DidModifyFiles(ctx, []file.Modification{{URI: protocol.URIFromPath(path), Action: action, Version: p.Revision, Text: []byte(p.Content), LanguageID: "go"}})
	if err != nil {
		return err
	}
	p.Path = path
	w.documents[path] = p
	w.epoch.Add(1)
	return nil
}

func (w *worker) closeDocument(ctx context.Context, raw string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session == nil {
		return fmt.Errorf("provider is not initialized")
	}
	path, err := canonical(raw)
	if err != nil {
		return err
	}
	if !within(w.root, path) {
		return fmt.Errorf("document is outside workspace")
	}
	_, exists := w.documents[path]
	if !exists {
		return nil
	}
	// The host owns dirty-buffer recovery and only closes clean mirrors.
	// External disk changes must not prevent standard didClose semantics.
	if _, err := w.session.DidModifyFiles(ctx, []file.Modification{{URI: protocol.URIFromPath(path), Action: file.Close, Version: -1}}); err != nil {
		return err
	}
	delete(w.documents, path)
	w.epoch.Add(1)
	return nil
}

// changed mirrors LSP didChangeWatchedFiles for disk events. OnDisk=true
// invalidates disk snapshots while preserving unsaved editor overlays.
func (w *worker) changed(ctx context.Context, paths []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session == nil {
		return fmt.Errorf("provider is not initialized")
	}
	modifications := make([]file.Modification, 0, len(paths))
	seen := map[string]bool{}
	for _, raw := range paths {
		path, err := canonical(raw)
		if err != nil {
			return err
		}
		if !within(w.root, path) {
			return fmt.Errorf("changed file is outside the workspace")
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		if w.protection != nil && w.protection.copies[path] != "" {
			content, err := w.protection.refresh(path)
			if err != nil {
				return err
			}
			w.protection.revision++
			modifications = append(modifications, file.Modification{URI: protocol.URIFromPath(path), Action: file.Change, Version: w.protection.revision, Text: content, LanguageID: "go.sum"})
			continue
		}
		action := file.Change
		if _, err := os.Stat(path); os.IsNotExist(err) {
			action = file.Delete
		} else if err != nil {
			return err
		}
		modifications = append(modifications, file.Modification{URI: protocol.URIFromPath(path), Action: action, OnDisk: true, Version: -1})
	}
	if len(modifications) == 0 {
		return nil
	}
	modifications = w.session.ExpandModificationsToDirectories(ctx, modifications)
	if _, err := w.session.DidModifyFiles(ctx, modifications); err != nil {
		return err
	}
	w.epoch.Add(1)
	return nil
}

type scopedSnapshot struct {
	context  buildContext
	snapshot *cache.Snapshot
	release  func()
}

func (w *worker) snapshots(q navigationQuery) ([]scopedSnapshot, string, uint64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session == nil {
		return nil, "", 0, fmt.Errorf("provider is not initialized")
	}
	if q.WorkspaceGeneration != w.generation {
		return nil, "", 0, fmt.Errorf("workspace generation is obsolete")
	}
	path, err := canonical(q.Path)
	if err != nil {
		return nil, "", 0, err
	}
	if !within(w.root, path) && (filepath.Ext(path) != ".go" || q.DocumentRevision != 0) {
		return nil, "", 0, fmt.Errorf("dependency source must be a read-only Go file at revision zero")
	}
	if w.documents[path].Revision != q.DocumentRevision {
		return nil, "", 0, fmt.Errorf("document revision is obsolete or not synchronized")
	}
	requested := map[string]bool{}
	for _, id := range q.ContextIDs {
		requested[id] = true
	}
	var result []scopedSnapshot
	w.prioritizeContextLocked(path)
	foundSourceContext := q.SourceContextID == ""
	for _, c := range w.contexts {
		if c.ID == q.SourceContextID {
			w.prioritizeContextIDLocked(c.ID)
		}
		// Retain the source context even if search is scoped to other consumers.
		selected := len(q.ContextIDs) == 0 || requested[c.ID] || within(c.Root, path) || c.ID == q.SourceContextID
		if !selected {
			continue
		}
		delete(requested, c.ID)
		if c.ID == q.SourceContextID {
			foundSourceContext = true
		}
		item := scopedSnapshot{context: c}
		if v := w.views[c.ID]; v != nil {
			snapshot, release, err := v.Snapshot()
			if err == nil {
				item.snapshot, item.release = snapshot, release
			}
		}
		result = append(result, item)
	}
	if len(requested) > 0 || !foundSourceContext {
		for _, s := range result {
			if s.release != nil {
				s.release()
			}
		}
		return nil, "", 0, fmt.Errorf("unknown requested Go contexts")
	}
	sort.SliceStable(result, func(i, j int) bool { return len(result[i].context.Root) > len(result[j].context.Root) })
	return result, path, w.epoch.Load(), nil
}
