// Copyright 2026 Zwip contributors.
// SPDX-License-Identifier: BSD-3-Clause

package golang

import (
	"context"
	"fmt"
	"go/ast"
	"go/types"
	"slices"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/cache/parsego"
	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/internal/diff"
)

// ZwipOrganizeImports exposes the existing producer's edits and error. The
// CodeActions dispatcher suppresses producer errors, which would otherwise
// look like a successful empty import-fix result to this protocol.
func ZwipOrganizeImports(ctx context.Context, snapshot *cache.Snapshot, fh file.Handle) ([]protocol.TextEdit, error) {
	parsed, err := snapshot.ParseGo(ctx, fh, parsego.Full)
	if err != nil {
		return nil, err
	}
	edits, _, err := allImportsFixes(ctx, snapshot, parsed)
	return edits, err
}

// ZwipIsMethod identifies renames requiring implicit interface coverage.
func ZwipIsMethod(ctx context.Context, snapshot *cache.Snapshot, fh file.Handle, pos protocol.Position) (bool, error) {
	pkg, parsed, err := NarrowestPackageForFile(ctx, snapshot, fh.URI())
	if err != nil {
		return false, err
	}
	tokenPos, err := parsed.PositionPos(pos)
	if err != nil {
		return false, err
	}
	cursor, ok := parsed.Cursor.FindByPos(tokenPos, tokenPos)
	if !ok {
		return false, ErrNoIdentFound
	}
	ident, ok := cursor.Node().(*ast.Ident)
	if !ok {
		return false, ErrNoIdentFound
	}
	function, ok := pkg.TypesInfo().ObjectOf(ident).(*types.Func)
	return ok && function.Signature().Recv() != nil, nil
}

// ZwipIsPackageName reports whether pos is on the name in a package clause.
func ZwipIsPackageName(ctx context.Context, snapshot *cache.Snapshot, fh file.Handle, pos protocol.Position) (bool, error) {
	_, inPackageName, err := parsePackageNameDecl(ctx, snapshot, fh, pos)
	return inPackageName, err
}

// ZwipRenamePackageName renames a package in place, as GoLand does: package
// clauses (including the external _test package) and importers' qualified
// references change, while the directory and import path stay. Upstream
// Rename always moves the directory, which needs resource moves.
func ZwipRenamePackageName(ctx context.Context, snapshot *cache.Snapshot, fh file.Handle, newName string) ([]protocol.DocumentChange, error) {
	if !isValidIdentifier(newName) {
		return nil, fmt.Errorf("invalid package name: %q", newName)
	}
	meta, err := snapshot.NarrowestMetadataForFile(ctx, fh.URI())
	if err != nil {
		return nil, err
	}
	if meta.Name == "main" {
		return nil, fmt.Errorf("can't rename package \"main\"")
	}
	if meta.Module != nil && meta.Module.Path == string(meta.PkgPath) {
		return nil, fmt.Errorf("renaming a module's root package is not supported")
	}
	edits := make(map[protocol.DocumentURI][]diff.Edit)
	if err := updatePackageDeclsAndImports(ctx, snapshot, fh, PackageName(newName), meta.PkgPath, edits, false); err != nil {
		return nil, err
	}
	result := make(map[protocol.DocumentURI][]protocol.TextEdit)
	for uri, list := range edits {
		target, err := snapshot.ReadFile(ctx, uri)
		if err != nil {
			return nil, err
		}
		content, err := target.Content()
		if err != nil {
			return nil, err
		}
		diff.SortEdits(list)
		// Import paths are rewritten to their unchanged value; drop those no-ops.
		list = slices.DeleteFunc(slices.Compact(list), func(edit diff.Edit) bool {
			return string(content[edit.Start:edit.End]) == edit.New
		})
		if len(list) == 0 {
			continue
		}
		converted, err := protocol.EditsFromDiffEdits(protocol.NewMapper(uri, content), list)
		if err != nil {
			return nil, err
		}
		result[uri] = converted
	}
	return editsToDocChanges(ctx, snapshot, result)
}
