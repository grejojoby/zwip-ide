package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func put(t *testing.T, root, name, content string) string {
	t.Helper()
	target := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func TestReferencesAcrossIndependentModules(t *testing.T) {
	root := t.TempDir()
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	source := put(t, root, "shared/shared.go", "package shared\nfunc Target() {}\n")
	for _, name := range []string{"first", "second"} {
		put(t, root, name+"/go.mod", "module fixture/"+name+"\n\ngo 1.25\nrequire fixture/shared v0.0.0\nreplace fixture/shared => ../shared\n")
		put(t, root, name+"/main.go", "package "+name+"\nimport \"fixture/shared\"\nfunc Call() { shared.Target() }\n")
	}
	w := newWorker()
	defer w.close()
	_, err := w.initialize(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: []buildContext{
		{ID: "shared", Root: filepath.Join(root, "shared"), Language: "go"},
		{ID: "first", Root: filepath.Join(root, "first"), Language: "go"},
		{ID: "second", Root: filepath.Join(root, "second"), Language: "go"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	result := w.query(context.Background(), navigationQuery{ID: "refs", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if result.State != "complete" {
		t.Fatalf("%+v", result)
	}
	if len(result.Locations) != 2 {
		t.Fatalf("want both unopened consumers, got %+v", result)
	}
	paths := result.Locations[0].Path + result.Locations[1].Path
	if !strings.Contains(paths, "first/main.go") || !strings.Contains(paths, "second/main.go") {
		t.Fatalf("wrong results: %+v", result)
	}
	if result.SearchedContexts != 3 {
		t.Fatalf("coverage: %+v", result)
	}
}
