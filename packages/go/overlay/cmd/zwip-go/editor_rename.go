package main

import (
	"context"
	"fmt"

	"golang.org/x/tools/gopls/internal/cache/metadata"
	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/protocol"
)

// editorRename computes a complete preview or returns no edits. Mutating the
// workspace and checking these edits' hashes is the host's atomic apply step.
func editorRename(ctx context.Context, scopes []scopedSnapshot, source *scopedSnapshot, fh file.Handle, pos position, newName string) ([]editorEdit, error) {
	if newName == "" {
		return nil, fmt.Errorf("newName is required")
	}
	if _, userErr, err := golang.PrepareRename(ctx, source.snapshot, fh, pos); userErr != nil {
		return nil, userErr
	} else if err != nil {
		return nil, err
	}
	definitions, err := golang.Definition(ctx, source.snapshot, fh, pos)
	if err != nil {
		return nil, err
	}
	if len(definitions) != 1 {
		return nil, fmt.Errorf("rename requires one resolved declaration")
	}
	declaration := definitions[0]
	declarationPath, err := canonical(declaration.URI.Path())
	if err != nil {
		return nil, err
	}
	isMethod, err := golang.ZwipIsMethod(ctx, source.snapshot, fh, pos)
	if err != nil {
		return nil, err
	}
	var result []editorEdit
	var otherDeclarations []struct {
		id    string
		graph *metadata.Graph
	}
	for _, scope := range scopes {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if scope.snapshot == nil {
			return nil, fmt.Errorf("rename blocked: context %s is unavailable", scope.context.ID)
		}
		snapshot := scope.snapshot
		graph, err := snapshot.LoadMetadataGraph(ctx)
		if err != nil {
			return nil, err
		}
		if loadErr := snapshot.InitializationError(); loadErr != nil {
			return nil, fmt.Errorf("rename blocked: context %s: %v", scope.context.ID, loadErr.MainError)
		}
		metas, err := snapshot.WorkspaceMetadata(ctx)
		if err != nil {
			return nil, err
		}
		for _, meta := range metas {
			if len(meta.Errors) > 0 || len(meta.DepsErrors) > 0 {
				return nil, fmt.Errorf("rename blocked: package %s in %s has load errors", meta.PkgPath, scope.context.ID)
			}
		}
		contextDeclarationURI := metadataSourceURI(graph, declarationPath)
		if contextDeclarationURI == "" {
			if isMethod {
				return nil, fmt.Errorf("rename blocked: implicit method relationships in independent context %s cannot be proven complete", scope.context.ID)
			}
			otherDeclarations = append(otherDeclarations, struct {
				id    string
				graph *metadata.Graph
			}{scope.context.ID, graph})
			continue
		}
		// Rename is less frequent than navigation. Reuse cached diagnostics, or
		// type-check affected workspace packages before allowing a multi-file edit.
		ids := make([]metadata.PackageID, 0, len(metas))
		for _, meta := range metas {
			ids = append(ids, meta.ID)
		}
		diagnostics, err := snapshot.PackageDiagnostics(ctx, ids...)
		if err != nil {
			return nil, err
		}
		for _, items := range diagnostics {
			for _, item := range items {
				if item.Severity == protocol.SeverityError {
					return nil, fmt.Errorf("rename blocked: context %s has errors: %s", scope.context.ID, item.Message)
				}
			}
		}
		target, err := snapshot.ReadFile(ctx, contextDeclarationURI)
		if err != nil {
			return nil, err
		}
		changes, err := golang.Rename(ctx, snapshot, target, declaration.Range.Start, newName)
		if err != nil {
			return nil, fmt.Errorf("rename blocked in %s: %w", scope.context.ID, err)
		}
		edits, err := documentChangesToEdits(ctx, scopes, snapshot, changes)
		if err != nil {
			return nil, err
		}
		result = append(result, edits...)
	}
	// A shared source file may bind a reference to different declarations in
	// two build profiles. Renaming only one declaration would break the other
	// profile; block that preview rather than silently widening symbol identity.
	for _, other := range otherDeclarations {
		for _, edit := range result {
			if metadataSourceURI(other.graph, edit.Path) != "" {
				return nil, fmt.Errorf("rename blocked: %s is compiled in context %s with a different declaration", edit.Path, other.id)
			}
		}
	}
	return normalizeEditorEdits(result)
}
