// Copyright 2026 Zwip contributors.
// SPDX-License-Identifier: BSD-3-Clause

package golang

import (
	"context"
	"fmt"
	"go/types"
	"sort"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/cache/metadata"
	"golang.org/x/tools/gopls/internal/cache/methodsets"
	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/gopls/internal/util/safetoken"
)

// ZwipRelationshipQuery carries upstream's existing method-set key between
// explicit module snapshots. It creates no second symbol or method-set index.
type ZwipRelationshipQuery struct {
	key           methodsets.Key
	method        *types.Func
	relation      methodsets.TypeRelation
	hasMethods    bool
	requiredFiles []protocol.DocumentURI
}

func ZwipPrepareRelationships(ctx context.Context, snapshot *cache.Snapshot, fh file.Handle, pos protocol.Position, bothDirections bool) (*ZwipRelationshipQuery, error) {
	pkg, pgf, err := NarrowestPackageForFile(ctx, snapshot, fh.URI())
	if err != nil {
		return nil, err
	}
	if len(pkg.TypeErrors()) > 0 {
		return nil, fmt.Errorf("source package has type errors; method-set key is not reliable")
	}
	tokenPos, err := pgf.PositionPos(pos)
	if err != nil {
		return nil, err
	}
	cursor, ok := pgf.Cursor.FindByPos(tokenPos, tokenPos)
	if !ok {
		return nil, ErrNoIdentFound
	}
	object, err := implementsObj(pkg.TypesInfo(), cursor)
	if err != nil {
		return nil, err
	}
	typ, method := typeOrMethod(object)
	if typ == nil {
		return nil, ErrNoIdentFound
	}
	key, hasMethods := methodsets.KeyOf(typ)
	relation := methodsets.Supertype
	if types.IsInterface(typ) {
		relation = methodsets.Subtype
	}
	if bothDirections {
		relation = methodsets.Subtype | methodsets.Supertype
	}
	query := &ZwipRelationshipQuery{key: key, method: method, relation: relation, hasMethods: hasMethods}
	// Method fingerprints encode package paths, not physical module identities.
	// Require every named signature type and private method to resolve to the
	// same source declaration before comparing keys from independent contexts.
	required := map[protocol.DocumentURI]bool{}
	addObject := func(obj types.Object) {
		if obj.Pkg() != nil && obj.Pos().IsValid() {
			filename := safetoken.StartPosition(pkg.FileSet(), obj.Pos()).Filename
			if filename != "" {
				required[protocol.URIFromPath(filename)] = true
			}
		}
	}
	seen := map[types.Type]bool{}
	var visit func(types.Type)
	visit = func(t types.Type) {
		if t == nil || seen[t] {
			return
		}
		seen[t] = true
		switch t := types.Unalias(t).(type) {
		case *types.Named:
			addObject(t.Obj())
			for i := 0; i < t.TypeArgs().Len(); i++ {
				visit(t.TypeArgs().At(i))
			}
		case *types.Pointer:
			visit(t.Elem())
		case *types.Slice:
			visit(t.Elem())
		case *types.Array:
			visit(t.Elem())
		case *types.Map:
			visit(t.Key())
			visit(t.Elem())
		case *types.Chan:
			visit(t.Elem())
		case *types.Tuple:
			for i := 0; i < t.Len(); i++ {
				visit(t.At(i).Type())
			}
		case *types.Signature:
			visit(t.Params())
			visit(t.Results())
		case *types.Struct:
			for i := 0; i < t.NumFields(); i++ {
				field := t.Field(i)
				if !field.Exported() {
					addObject(field)
				}
				visit(field.Type())
			}
		case *types.Interface:
			for i := 0; i < t.NumMethods(); i++ {
				m := t.Method(i)
				if !m.Exported() {
					addObject(m)
				}
				visit(m.Type())
			}
		}
	}
	methodType := typ
	if !types.IsInterface(typ) {
		if _, ok := typ.(*types.Pointer); !ok {
			methodType = types.NewPointer(typ)
		}
	}
	methods := types.NewMethodSet(methodType)
	for i := 0; i < methods.Len(); i++ {
		m := methods.At(i).Obj()
		if !m.Exported() {
			addObject(m)
		}
		visit(m.Type())
	}
	for uri := range required {
		query.requiredFiles = append(query.requiredFiles, uri)
	}
	sort.Slice(query.requiredFiles, func(i, j int) bool { return query.requiredFiles[i] < query.requiredFiles[j] })
	return query, nil
}

// ZwipRelationships searches package-level types in one independent module.
// Upstream function-local and generic limitations remain visible to the host.
func ZwipRelationships(ctx context.Context, snapshot *cache.Snapshot, query *ZwipRelationshipQuery) ([]protocol.Location, error) {
	if !query.hasMethods {
		return nil, nil
	}
	graph, err := snapshot.LoadMetadataGraph(ctx)
	if err != nil {
		return nil, err
	}
	for _, uri := range query.requiredFiles {
		if len(graph.ForFile[uri]) == 0 {
			return nil, nil
		}
	}
	metas, err := snapshot.WorkspaceMetadata(ctx)
	if err != nil {
		return nil, err
	}
	metadata.RemoveIntermediateTestVariants(&metas)
	ids := make([]metadata.PackageID, 0, len(metas))
	for _, meta := range metas {
		ids = append(ids, meta.ID)
	}
	indexes, err := snapshot.MethodSets(ctx, ids...)
	if err != nil {
		return nil, err
	}
	var locations []protocol.Location
	for _, index := range indexes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, result := range index.Search(query.key, query.relation, query.method) {
			loc, err := offsetToLocation(ctx, snapshot, result.Location.Filename, result.Location.Start, result.Location.End)
			if err != nil {
				return nil, err
			}
			locations = append(locations, loc)
		}
	}
	return locations, nil
}
