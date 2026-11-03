package main

import (
	"context"
	"fmt"
	"go/parser"
	"go/token"
	"sort"
	"strings"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/gopls/internal/settings"
)

type workspaceSymbolQuery struct {
	ID                  string `json:"id"`
	Query               string `json:"query"`
	WorkspaceGeneration int64  `json:"workspaceGeneration"`
}

func (w *worker) workspaceSymbols(ctx context.Context, q workspaceSymbolQuery) (result navigationBatch) {
	result = navigationBatch{ID: q.ID, WorkspaceGeneration: q.WorkspaceGeneration, State: "complete", Locations: []sourceLocation{}, Reasons: []string{}}
	w.mu.Lock()
	if w.session == nil || q.WorkspaceGeneration != w.generation {
		w.mu.Unlock()
		result.State = "failed"
		result.Reasons = append(result.Reasons, "provider unavailable or workspace generation obsolete")
		return
	}
	epoch := w.epoch.Load()
	var snapshots []scopedSnapshot
	for _, c := range w.contexts {
		item := scopedSnapshot{context: c}
		if view := w.views[c.ID]; view != nil {
			item.snapshot, item.release, _ = view.Snapshot()
		}
		snapshots = append(snapshots, item)
	}
	w.mu.Unlock()
	defer func() {
		for _, item := range snapshots {
			if item.release != nil {
				item.release()
			}
		}
		if ctx.Err() != nil || w.epoch.Load() != epoch {
			result.State = "canceled"
			result.Locations = []sourceLocation{}
			result.Reasons = append(result.Reasons, "query canceled or workspace changed")
		}
	}()
	result.TotalContexts = len(snapshots)
	for _, item := range snapshots {
		if ctx.Err() != nil {
			break
		}
		if item.snapshot == nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, item.context.ID+": "+item.context.Reason)
			continue
		}
		metadata, err := item.snapshot.WorkspaceMetadata(ctx)
		if err != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, item.context.ID+": "+err.Error())
			continue
		}
		for _, pkg := range metadata {
			if len(pkg.Errors) > 0 || len(pkg.DepsErrors) > 0 {
				result.State = "partial"
				result.Reasons = append(result.Reasons, item.context.ID+": package load errors may omit symbols")
				break
			}
		}
		// WorkspaceSymbols returns declarations inside packages, but not package clauses.
		// Match both the declared name and import path; open one declaration per package.
		seenPackages := make(map[string]bool)
		query := strings.ToLower(strings.TrimSpace(q.Query))
	packages:
		for _, pkg := range metadata {
			if ctx.Err() != nil {
				break
			}
			if query == "" || (!strings.Contains(strings.ToLower(string(pkg.Name)), query) && !strings.Contains(strings.ToLower(string(pkg.PkgPath)), query)) {
				continue
			}
			uris := append([]protocol.DocumentURI(nil), pkg.GoFiles...)
			sort.Slice(uris, func(i, j int) bool { return uris[i] < uris[j] })
			for _, uri := range uris {
				if !within(item.context.Root, uri.Path()) {
					continue
				}
				key := string(pkg.PkgPath) + ":" + string(pkg.Name)
				if seenPackages[key] {
					break
				}
				if len(seenPackages) >= 100 {
					result.State = "partial"
					result.Reasons = append(result.Reasons, item.context.ID+": package result limit reached; refine the query")
					break packages
				}
				entry, err := describePackage(ctx, item.snapshot, uri, item.context.ID)
				if err != nil {
					result.State = "partial"
					result.Reasons = append(result.Reasons, err.Error())
					continue
				}
				seenPackages[key] = true
				result.Locations = append(result.Locations, entry)
				break
			}
		}
		symbols, err := golang.WorkspaceSymbols(ctx, settings.SymbolFuzzy, settings.DynamicSymbols, []*cache.Snapshot{item.snapshot}, q.Query)
		if err != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, item.context.ID+": "+err.Error())
			continue
		}
		result.SearchedContexts++
		if len(symbols) >= 100 {
			result.State = "partial"
			result.Reasons = append(result.Reasons, fmt.Sprintf("%s: upstream symbol result limit reached; refine the query", item.context.ID))
		}
		for _, symbol := range symbols {
			if !within(item.context.Root, symbol.Location.URI.Path()) {
				continue
			}
			entry, err := describeLocation(ctx, item.snapshot, symbol.Location, item.context.ID, "workspace symbol")
			if err != nil {
				result.State = "partial"
				result.Reasons = append(result.Reasons, err.Error())
				continue
			}
			entry.Name = symbol.Name
			result.Locations = append(result.Locations, entry)
		}
	}
	sort.SliceStable(result.Locations, func(i, j int) bool {
		a, b := result.Locations[i], result.Locations[j]
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Range.Start.Line < b.Range.Start.Line
	})
	return
}

func describePackage(ctx context.Context, snapshot *cache.Snapshot, uri protocol.DocumentURI, contextID string) (sourceLocation, error) {
	fh, err := snapshot.ReadFile(ctx, uri)
	if err != nil {
		return sourceLocation{}, err
	}
	content, err := fh.Content()
	if err != nil {
		return sourceLocation{}, err
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, uri.Path(), content, parser.PackageClauseOnly)
	if err != nil {
		return sourceLocation{}, err
	}
	start := fset.Position(file.Name.Pos()).Offset
	end := fset.Position(file.Name.End()).Offset
	rng, err := protocol.NewMapper(uri, content).OffsetRange(start, end)
	if err != nil {
		return sourceLocation{}, err
	}
	return describeLocation(ctx, snapshot, protocol.Location{URI: uri, Range: rng}, contextID, "package")
}
