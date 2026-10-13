package main

import (
	"context"
	"fmt"
	"path/filepath"

	"golang.org/x/tools/gopls/internal/cache/metadata"
	"golang.org/x/tools/gopls/internal/protocol"
)

// Select dependency source by exact physical URI in a loaded metadata graph.
// An import-path match is insufficient: different contexts may pin different
// versions or replace the same module with different directories.
func sourceContext(ctx context.Context, scopes []scopedSnapshot, path, preferred string) (*scopedSnapshot, protocol.DocumentURI, error) {
	if preferred == "" {
		for i := range scopes {
			if scopes[i].context.ProfileID == "" && within(scopes[i].context.Root, path) {
				return &scopes[i], protocol.URIFromPath(path), nil
			}
		}
	}
	for i := range scopes {
		scope := &scopes[i]
		if preferred == "" && scope.context.ProfileID != "" {
			continue
		}
		if preferred != "" && scope.context.ID != preferred {
			continue
		}
		if preferred != "" && (scope.context.State == "loading" || within(scope.context.Root, path)) {
			return scope, protocol.URIFromPath(path), nil
		}
		if scope.snapshot == nil {
			continue
		}
		graph, err := scope.snapshot.LoadMetadataGraph(ctx)
		if err != nil {
			continue
		}
		if uri := metadataSourceURI(graph, path); uri != "" {
			return scope, uri, nil
		}
	}
	return nil, "", fmt.Errorf("no selected default context owns this exact source; select an explicit sourceContextId for a build profile and retry if indexing is loading")
}

func requireContextSource(ctx context.Context, scope *scopedSnapshot, uri protocol.DocumentURI) error {
	if scope.snapshot.IsBuiltin(uri) {
		return nil
	}
	graph, err := scope.snapshot.LoadMetadataGraph(ctx)
	if err != nil {
		return err
	}
	for _, pkg := range graph.ForFile[uri] {
		if !metadata.IsCommandLineArguments(pkg.ID) {
			return nil
		}
	}
	return fmt.Errorf("source file is excluded or unavailable in context %s; choose a sourceContextId whose target and build tags include the file", scope.context.ID)
}

// Absolute replace paths can spell /var and /private/var differently on macOS.
// Resolve only metadata-owned files with the same basename, then compare their
// canonical paths. This is path identity, not a second semantic index.
func metadataSourceURI(graph *metadata.Graph, path string) protocol.DocumentURI {
	uri := protocol.URIFromPath(path)
	if len(graph.ForFile[uri]) > 0 {
		return uri
	}
	for candidate := range graph.ForFile {
		if filepath.Base(candidate.Path()) != filepath.Base(path) {
			continue
		}
		physical, err := canonical(candidate.Path())
		if err == nil && physical == path {
			return candidate
		}
	}
	return ""
}
