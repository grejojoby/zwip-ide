// Copyright 2026 Zwip contributors.
// SPDX-License-Identifier: BSD-3-Clause

package golang

import (
	"context"
	"go/ast"
	"go/types"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/cache/parsego"
	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/protocol"
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
