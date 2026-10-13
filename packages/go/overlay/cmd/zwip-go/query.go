package main

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/cache/metadata"
	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/protocol"
)

func (w *worker) query(ctx context.Context, q navigationQuery) (result navigationBatch) {
	return w.queryProgress(ctx, q, nil)
}

func (w *worker) queryProgress(ctx context.Context, q navigationQuery, progress func(navigationBatch)) (result navigationBatch) {
	result = navigationBatch{ID: q.ID, DocumentRevision: q.DocumentRevision, WorkspaceGeneration: q.WorkspaceGeneration, State: "complete", Locations: []sourceLocation{}, Reasons: []string{}}
	if ctx.Err() != nil {
		result.State = "canceled"
		result.Reasons = append(result.Reasons, "query canceled")
		return result
	}
	supported := map[string]bool{"definition": true, "typeDefinition": true, "references": true, "implementations": true, "typeHierarchy": true, "incomingCalls": true, "outgoingCalls": true}
	if !supported[q.Operation] {
		result.State = "unsupported"
		result.Reasons = append(result.Reasons, "unsupported Go navigation operation: "+q.Operation)
		return result
	}
	scopes, path, epoch, err := w.snapshots(q)
	if err != nil {
		result.State = "failed"
		result.Reasons = append(result.Reasons, err.Error())
		return result
	}
	defer func() {
		if ctx.Err() != nil || w.epoch.Load() != epoch {
			result.State = "canceled"
			result.Reasons = append(result.Reasons, "query was canceled or its document snapshot changed")
		}
		for _, s := range scopes {
			if s.release != nil {
				s.release()
			}
		}
	}()
	source, sourceURI, err := sourceContext(ctx, scopes, path, q.SourceContextID)
	if err != nil {
		result.State = "partial"
		result.TotalContexts = len(scopes)
		result.Reasons = append(result.Reasons, err.Error())
		return result
	}
	if source == nil || source.snapshot == nil {
		if source != nil && source.context.State == "loading" {
			result.State = "partial"
			result.TotalContexts = len(scopes)
			if q.Operation == "definition" || q.Operation == "typeDefinition" || q.Operation == "outgoingCalls" {
				result.TotalContexts = 1
			}
			result.Reasons = append(result.Reasons, source.context.ID+": indexing is still loading; retry after workspace.status reports ready")
			return result
		}
		result.State = "failed"
		result.Reasons = append(result.Reasons, "source Go build context is unavailable")
		return result
	}
	if err := requireContextSource(ctx, source, sourceURI); err != nil {
		result.State = "partial"
		result.TotalContexts = len(scopes)
		result.Reasons = append(result.Reasons, err.Error())
		return result
	}
	sourceFile, err := source.snapshot.ReadFile(ctx, sourceURI)
	if err != nil {
		result.State = "failed"
		result.Reasons = append(result.Reasons, err.Error())
		return result
	}
	sourcePackage, _, err := golang.NarrowestPackageForFile(ctx, source.snapshot, sourceURI)
	if err != nil {
		result.State = "failed"
		result.Reasons = append(result.Reasons, err.Error())
		return result
	}
	if errors := sourcePackage.TypeErrors(); len(errors) > 0 {
		result.State = "partial"
		result.Reasons = append(result.Reasons, source.context.ID+": source package has type errors: "+errors[0].Msg)
	}
	if len(sourcePackage.ParseErrors()) > 0 {
		result.State = "partial"
		result.Reasons = append(result.Reasons, source.context.ID+": source package has parse errors")
	}
	if detail := packageLoadError(sourcePackage.Metadata()); detail != "" {
		result.State = "partial"
		result.Reasons = append(result.Reasons, source.context.ID+": source package has load errors: "+detail)
	}
	global := q.Operation != "definition" && q.Operation != "typeDefinition" && q.Operation != "outgoingCalls"
	requested := map[string]bool{}
	for _, id := range q.ContextIDs {
		requested[id] = true
	}
	var targets []scopedSnapshot
	for _, s := range scopes {
		if !global && s.context.ID != source.context.ID {
			continue
		}
		if global && len(requested) > 0 && !requested[s.context.ID] {
			continue
		}
		targets = append(targets, s)
	}
	result.TotalContexts = len(targets)
	// The originating context normally has the most useful immediate results.
	sort.SliceStable(targets, func(i, j int) bool {
		return targets[i].context.ID == source.context.ID && targets[j].context.ID != source.context.ID
	})
	declaration := protocol.Location{URI: sourceURI, Range: protocol.Range{Start: q.Position, End: q.Position}}
	if global {
		defs, err := golang.Definition(ctx, source.snapshot, sourceFile, q.Position)
		if err != nil {
			result.State = "failed"
			result.Reasons = append(result.Reasons, err.Error())
			return result
		}
		if len(defs) != 1 {
			result.State = "unsupported"
			result.Reasons = append(result.Reasons, "query needs one resolved declaration")
			return result
		}
		declaration = defs[0]
	}
	var relationshipQuery *golang.ZwipRelationshipQuery
	var relationshipError error
	if q.Operation == "implementations" || q.Operation == "typeHierarchy" {
		relationshipQuery, relationshipError = golang.ZwipPrepareRelationships(ctx, source.snapshot, sourceFile, q.Position, q.Operation == "typeHierarchy")
		// Ordinary function implementations are handled by upstream in the source
		// dependency graph; a method-set query may therefore be unavailable.
	}
	byLocation := map[string]int{}
	publish := func() {
		if progress == nil || ctx.Err() != nil || w.epoch.Load() != epoch {
			return
		}
		batch := result
		batch.State = "loading"
		batch.Reasons = append([]string{}, result.Reasons...)
		batch.Locations = append([]sourceLocation{}, result.Locations...)
		for i := range batch.Locations {
			batch.Locations[i].ContextIDs = append([]string{}, batch.Locations[i].ContextIDs...)
		}
		sortNavigationLocations(batch.Locations)
		progress(batch)
	}
	for index, s := range targets {
		if index > 0 {
			publish()
		}
		if ctx.Err() != nil || w.epoch.Load() != epoch {
			result.State = "canceled"
			result.Reasons = append(result.Reasons, "query canceled")
			break
		}
		if s.snapshot == nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": "+s.context.Reason)
			continue
		}
		snapshot := s.snapshot
		graph, err := snapshot.LoadMetadataGraph(ctx)
		if err != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": "+err.Error())
			continue
		}
		if loadErr := snapshot.InitializationError(); global && loadErr != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": "+loadErr.MainError.Error())
		}
		if global {
			metas, err := snapshot.WorkspaceMetadata(ctx)
			if err != nil {
				result.State = "partial"
				result.Reasons = append(result.Reasons, s.context.ID+": "+err.Error())
				continue
			}
			sort.Slice(metas, func(i, j int) bool { return metas[i].ID < metas[j].ID })
			for _, meta := range metas {
				if detail := packageLoadError(meta); detail != "" {
					result.State = "partial"
					result.Reasons = append(result.Reasons, fmt.Sprintf("%s: package %s has load errors: %s", s.context.ID, meta.PkgPath, detail))
					break
				}
			}
		}
		// A broken unrelated package limits workspace coverage, but must not
		// discard verified results from healthy packages in the same context.
		declarationPath, _ := canonical(declaration.URI.Path())
		contextDeclarationURI := metadataSourceURI(graph, declarationPath)
		outsideGraph := global && contextDeclarationURI == ""
		structural := q.Operation == "implementations" || q.Operation == "typeHierarchy"
		if outsideGraph && !structural {
			result.SearchedContexts++
			continue
		}
		queryURI, queryPosition := sourceURI, q.Position
		if global {
			queryURI, queryPosition = declaration.URI, declaration.Range.Start
			if contextDeclarationURI != "" {
				queryURI = contextDeclarationURI
			}
		}
		fh, err := snapshot.ReadFile(ctx, queryURI)
		if err != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": "+err.Error())
			continue
		}
		var locations []protocol.Location
		var locationRelationships []string
		relationship := q.Operation
		if outsideGraph {
			if relationshipQuery == nil {
				result.State = "partial"
				result.Reasons = append(result.Reasons, fmt.Sprintf("%s: cross-context relationship unavailable: %v", s.context.ID, relationshipError))
				continue
			}
			locations, err = golang.ZwipRelationships(ctx, snapshot, relationshipQuery)
			relationship = "method-set candidate"
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": searched package-level method sets; unrelated function-local types are not indexed and generic matches are candidates")
		} else {
			switch q.Operation {
			case "definition":
				locations, err = golang.Definition(ctx, snapshot, fh, queryPosition)
			case "typeDefinition":
				locations, err = golang.TypeDefinition(ctx, snapshot, fh, queryPosition)
			case "references":
				locations, err = golang.References(ctx, snapshot, fh, queryPosition, false)
			case "implementations":
				locations, err = golang.Implementation(ctx, snapshot, fh, queryPosition)
				relationship = "method-set candidate"
			case "typeHierarchy":
				var items []protocol.TypeHierarchyItem
				items, err = golang.PrepareTypeHierarchy(ctx, snapshot, fh, queryPosition)
				if err == nil {
					for _, item := range items {
						var up, down []protocol.TypeHierarchyItem
						up, err = golang.Supertypes(ctx, snapshot, fh, item)
						if err != nil {
							break
						}
						down, err = golang.Subtypes(ctx, snapshot, fh, item)
						if err != nil {
							break
						}
						for _, node := range up {
							locations = append(locations, protocol.Location{URI: node.URI, Range: node.SelectionRange})
							locationRelationships = append(locationRelationships, "method-set supertype")
						}
						for _, node := range down {
							locations = append(locations, protocol.Location{URI: node.URI, Range: node.SelectionRange})
							locationRelationships = append(locationRelationships, "method-set subtype")
						}
					}
				}
				relationship = "static type relation"
			case "incomingCalls":
				var calls []protocol.CallHierarchyIncomingCall
				calls, err = golang.IncomingCalls(ctx, snapshot, fh, queryPosition)
				for _, call := range calls {
					locations = append(locations, protocol.Location{URI: call.From.URI, Range: call.From.SelectionRange})
				}
				relationship = "static caller"
			case "outgoingCalls":
				var calls []protocol.CallHierarchyOutgoingCall
				calls, err = golang.OutgoingCalls(ctx, snapshot, fh, queryPosition)
				for _, call := range calls {
					locations = append(locations, protocol.Location{URI: call.To.URI, Range: call.To.SelectionRange})
				}
				relationship = "static callee"
			}
		}
		if err != nil {
			result.State = "partial"
			result.Reasons = append(result.Reasons, s.context.ID+": "+err.Error())
			continue
		}
		result.SearchedContexts++
		for locationIndex, location := range locations {
			// Navigation to dependency source is useful. Workspace relationship results
			// are limited to explicitly included roots, not every loaded dependency.
			if global {
				physicalLocation, _ := canonical(location.URI.Path())
				included := false
				for _, candidate := range targets {
					if within(candidate.context.Root, physicalLocation) {
						included = true
						break
					}
				}
				if !included {
					continue
				}
			}
			locationRelationship := relationship
			if locationIndex < len(locationRelationships) {
				locationRelationship = locationRelationships[locationIndex]
			}
			entry, err := describeLocation(ctx, snapshot, location, s.context.ID, locationRelationship)
			if err != nil {
				result.State = "partial"
				result.Reasons = append(result.Reasons, err.Error())
				continue
			}
			key := fmt.Sprintf("%s:%d:%d:%d:%d:%s", entry.Path, entry.Range.Start.Line, entry.Range.Start.Character, entry.Range.End.Line, entry.Range.End.Character, entry.Relationship)
			if index, exists := byLocation[key]; exists {
				prior := &result.Locations[index]
				found := false
				for _, id := range prior.ContextIDs {
					if id == s.context.ID {
						found = true
					}
				}
				if !found {
					prior.ContextIDs = append(prior.ContextIDs, s.context.ID)
				}
			} else {
				byLocation[key] = len(result.Locations)
				result.Locations = append(result.Locations, entry)
			}
		}
	}
	if len(targets) > 0 {
		publish()
	}
	sortNavigationLocations(result.Locations)
	return result
}

func sortNavigationLocations(locations []sourceLocation) {
	sort.Slice(locations, func(i, j int) bool {
		a, b := locations[i], locations[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Range.Start.Line != b.Range.Start.Line {
			return a.Range.Start.Line < b.Range.Start.Line
		}
		return a.Range.Start.Character < b.Range.Start.Character
	})
}

func packageLoadError(meta *metadata.Package) string {
	if len(meta.Errors) > 0 {
		return meta.Errors[0].Msg
	}
	if len(meta.DepsErrors) > 0 {
		return meta.DepsErrors[0].Err
	}
	return ""
}

func describeLocation(ctx context.Context, snapshot *cache.Snapshot, loc protocol.Location, contextID, relationship string) (sourceLocation, error) {
	fh, err := snapshot.ReadFile(ctx, loc.URI)
	if err != nil {
		return sourceLocation{}, err
	}
	content, err := fh.Content()
	if err != nil {
		return sourceLocation{}, err
	}
	mapper := protocol.NewMapper(loc.URI, content)
	start, end, err := mapper.RangeOffsets(loc.Range)
	if err != nil {
		return sourceLocation{}, err
	}
	lineStart := strings.LastIndex(string(content[:start]), "\n") + 1
	lineEnd := strings.Index(string(content[end:]), "\n")
	if lineEnd < 0 {
		lineEnd = len(content)
	} else {
		lineEnd += end
	}
	name := string(content[start:end])
	if name == "" {
		name = string(content[lineStart:lineEnd])
	}
	physicalPath, err := canonical(loc.URI.Path())
	if err != nil {
		return sourceLocation{}, err
	}
	return sourceLocation{Path: physicalPath, Range: loc.Range, Name: name, Preview: strings.TrimSpace(string(content[lineStart:lineEnd])), ContextIDs: []string{contextID}, Relationship: relationship}, nil
}
