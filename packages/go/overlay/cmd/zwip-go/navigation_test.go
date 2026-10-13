package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func startFixture(t *testing.T, root string, names ...string) *worker {
	t.Helper()
	contexts := make([]buildContext, 0, len(names))
	for _, name := range names {
		contexts = append(contexts, buildContext{ID: name, Root: filepath.Join(root, name), Language: "go"})
	}
	w := newWorker()
	t.Cleanup(w.close)
	states, err := w.initialize(context.Background(), initializeParams{Root: root, Contexts: contexts, Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range states {
		if state.State != "ready" {
			t.Fatalf("context failed: %+v", state)
		}
	}
	return w
}

func fixtureConsumer(t *testing.T, root, name, replacement string) string {
	t.Helper()
	put(t, root, name+"/go.mod", "module fixture/"+name+"\n\ngo 1.25\nrequire fixture/shared v0.0.0\nreplace fixture/shared => ../"+replacement+"\n")
	return put(t, root, name+"/main.go", "package "+name+"\nimport \"fixture/shared\"\nfunc Call() { shared.Target() }\n")
}

func TestContextIdentityScopeAndUnsavedOverlay(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"shared", "other"} {
		put(t, root, name+"/go.mod", "module fixture/shared\n\ngo 1.25\n")
		put(t, root, name+"/shared.go", "package shared\nfunc Target() {}\n")
	}
	first := fixtureConsumer(t, root, "first", "shared")
	second := fixtureConsumer(t, root, "second", "shared")
	fixtureConsumer(t, root, "unrelated", "other")
	w := startFixture(t, root, "shared", "other", "first", "second", "unrelated")
	q := navigationQuery{ID: "refs", Operation: "references", Path: filepath.Join(root, "shared/shared.go"), Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	result := w.query(context.Background(), q)
	if result.State != "complete" || len(result.Locations) != 2 {
		t.Fatalf("distinct replace roots must not merge: %+v", result)
	}
	q.ContextIDs = []string{"second"}
	result = w.query(context.Background(), q)
	if len(result.Locations) != 1 || result.Locations[0].Path != second || result.SearchedContexts != 1 || result.TotalContexts != 1 || strings.Join(result.Locations[0].ContextIDs, ",") != "second" {
		t.Fatalf("scope/provenance: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: first, Content: "package first\nfunc Call() {}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	q.ContextIDs = nil
	result = w.query(context.Background(), q)
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != second {
		t.Fatalf("overlay not federated: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: first, Content: "package first", Revision: 1}); err == nil {
		t.Fatal("accepted conflicting content at same revision")
	}
	q.WorkspaceGeneration = 2
	if got := w.query(context.Background(), q); got.State != "failed" {
		t.Fatalf("accepted stale generation: %+v", got)
	}
}

func TestStructuralImplementationsInUnrelatedModule(t *testing.T) {
	root := t.TempDir()
	put(t, root, "api/go.mod", "module fixture/api\n\ngo 1.25\n")
	source := put(t, root, "api/api.go", "package api\ntype Pinger interface { Ping() }\n")
	put(t, root, "impl/go.mod", "module fixture/impl\n\ngo 1.25\n")
	target := put(t, root, "impl/impl.go", "package impl\ntype private struct{}\nfunc (*private) Ping() {}\n")
	w := startFixture(t, root, "api", "impl")
	q := navigationQuery{ID: "impl", Operation: "implementations", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	for _, operation := range []string{"implementations", "typeHierarchy"} {
		q.Operation = operation
		result := w.query(context.Background(), q)
		if result.State != "partial" || result.SearchedContexts != 2 || len(result.Locations) != 1 || result.Locations[0].Path != target || result.Locations[0].Name != "private" {
			t.Fatalf("%s: %+v", operation, result)
		}
	}
}

func TestCanceledUnsupportedAndUnsavedNewFile(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\nfunc Target() {}\n")
	w := startFixture(t, root, "app")
	q := navigationQuery{ID: "q", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := w.query(ctx, q); got.State != "canceled" {
		t.Fatalf("%+v", got)
	}
	q.Operation = "rename"
	if got := w.query(context.Background(), q); got.State != "unsupported" {
		t.Fatalf("%+v", got)
	}
	newPath := filepath.Join(root, "app/new.go")
	newPath, _ = canonical(newPath)
	if err := w.update(context.Background(), documentUpdate{Path: newPath, Content: "package app\nfunc Call() { Target() }\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	q.Operation = "references"
	result := w.query(context.Background(), q)
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != newPath {
		t.Fatalf("unsaved new file: %+v", result)
	}
}

func TestThirtyThreeIndependentContexts(t *testing.T) {
	if testing.Short() {
		t.Skip("33-module integration fixture")
	}
	root := t.TempDir()
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	source := put(t, root, "shared/shared.go", "package shared\nfunc Target() {}\n")
	names := []string{"shared"}
	for i := 0; i < 32; i++ {
		name := fmt.Sprintf("consumer%02d", i)
		fixtureConsumer(t, root, name, "shared")
		names = append(names, name)
	}
	w := startFixture(t, root, names...)
	result := w.query(context.Background(), navigationQuery{ID: "refs", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if result.State != "complete" || result.SearchedContexts != 33 || result.TotalContexts != 33 || len(result.Locations) != 32 {
		t.Fatalf("33 contexts: %+v", result)
	}
}

func TestNamedSignatureIdentityAcrossReplaceRoots(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"types1", "types2"} {
		put(t, root, name+"/go.mod", "module fixture/types\n\ngo 1.25\n")
		put(t, root, name+"/types.go", "package types\ntype Value struct{}\n")
	}
	for _, spec := range []struct{ name, replacement string }{{"api", "types1"}, {"good", "types1"}, {"bad", "types2"}} {
		put(t, root, spec.name+"/go.mod", "module fixture/"+spec.name+"\n\ngo 1.25\nrequire fixture/types v0.0.0\nreplace fixture/types => ../"+spec.replacement+"\n")
	}
	source := put(t, root, "api/api.go", "package api\nimport \"fixture/types\"\ntype Consumer interface { Accept(types.Value) }\n")
	good := put(t, root, "good/good.go", "package good\nimport \"fixture/types\"\ntype Impl struct{}\nfunc (Impl) Accept(types.Value) {}\n")
	put(t, root, "bad/bad.go", "package bad\nimport \"fixture/types\"\ntype Impl struct{}\nfunc (Impl) Accept(types.Value) {}\n")
	w := startFixture(t, root, "api", "good", "bad", "types1", "types2")
	result := w.query(context.Background(), navigationQuery{ID: "impl", Operation: "implementations", Path: source, Position: position{Line: 2, Character: 6}, WorkspaceGeneration: 1})
	if result.State != "partial" || len(result.Locations) != 1 || result.Locations[0].Path != good {
		t.Fatalf("named types from different replace targets merged: %+v", result)
	}
}

func TestVendoredModuleDefinition(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\nrequire fixture/dependency v0.0.0\n")
	put(t, root, "app/vendor/modules.txt", "# fixture/dependency v0.0.0\n## explicit; go 1.25\nfixture/dependency\n")
	dependency := put(t, root, "app/vendor/fixture/dependency/dep.go", "package dependency\nfunc Target() {}\n")
	source := put(t, root, "app/main.go", "package app\nimport \"fixture/dependency\"\nfunc Call() { dependency.Target() }\n")
	w := startFixture(t, root, "app")
	result := w.query(context.Background(), navigationQuery{ID: "definition", Operation: "definition", Path: source, Position: position{Line: 2, Character: 25}, WorkspaceGeneration: 1})
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != dependency {
		t.Fatalf("vendor semantics changed: %+v", result)
	}
}

func TestTypeErrorsAndWorkspaceGenerationAreExplicit(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\nfunc Target() {}\nvar broken UnknownType\nfunc Caller() { Target() }\n")
	w := startFixture(t, root, "app")
	query := navigationQuery{ID: "refs", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	result := w.query(context.Background(), query)
	if result.State != "partial" || len(result.Reasons) == 0 {
		t.Fatalf("type error reported complete: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: source, Content: "package app\nfunc Target() {}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	query.DocumentRevision = 1
	if result = w.query(context.Background(), query); result.State != "complete" || len(result.Locations) != 0 {
		t.Fatalf("fixed overlay: %+v", result)
	}
	if _, err := w.initialize(context.Background(), initializeParams{Root: root, Generation: 2, Contexts: []buildContext{{ID: "app", Root: filepath.Join(root, "app"), Language: "go"}}}); err != nil {
		t.Fatal(err)
	}
	if result = w.query(context.Background(), query); result.State != "failed" {
		t.Fatalf("old generation accepted: %+v", result)
	}
	query.WorkspaceGeneration = 2
	query.DocumentRevision = 0
	result = w.query(context.Background(), query)
	if result.State != "partial" || len(result.Locations) != 1 {
		t.Fatalf("old overlay leaked into replacement session: %+v", result)
	}
}

func TestUnrelatedBrokenPackagePreservesVerifiedNavigation(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/healthy/main.go", "package healthy\nfunc Target(){}\nfunc Caller(){Target()}\n")
	put(t, root, "app/broken/main.go", "package broken\nimport _ \"fixture/missing\"\n")
	w := startFixture(t, root, "app")
	definition := w.query(context.Background(), navigationQuery{ID: "definition", Operation: "definition", Path: source, Position: position{Line: 2, Character: 14}, WorkspaceGeneration: 1})
	if definition.State != "complete" || len(definition.Locations) != 1 || definition.Locations[0].Range.Start.Line != 1 {
		t.Fatalf("unrelated package hid a valid definition: %+v", definition)
	}
	references := w.query(context.Background(), navigationQuery{ID: "refs", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if references.State != "partial" || len(references.Locations) != 1 || references.Locations[0].Range.Start.Line != 2 || len(references.Reasons) == 0 {
		t.Fatalf("partial search discarded verified reference: %+v", references)
	}
}
