package main

import (
	"context"
	"fmt"
	"sort"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/golang"
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
