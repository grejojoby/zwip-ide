package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditorFormattingHoverSymbolsAndDiagnostics(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\nvar MyValue=1\nfunc Read()int{return MyValue}\n")
	w := startFixture(t, root, "app")
	q := editorQuery{ID: "editor", Path: source, WorkspaceGeneration: 1}
	q.Operation = "format"
	result := w.editor(context.Background(), q)
	if result.State != "complete" || len(result.Edits) == 0 || result.Edits[0].FileHash == "" {
		t.Fatalf("format: %+v", result)
	}
	q.Operation = "hover"
	q.Position = &position{Line: 1, Character: 5}
	result = w.editor(context.Background(), q)
	if result.State != "complete" || !strings.Contains(result.Hover, "MyValue") {
		t.Fatalf("hover: %+v", result)
	}
	q.Operation = "symbols"
	result = w.editor(context.Background(), q)
	if result.State != "complete" || len(result.Symbols) != 2 {
		t.Fatalf("symbols: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: source, Content: "package app\nvar broken UnknownType\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	q.Operation = "diagnostics"
	q.DocumentRevision = 1
	result = w.editor(context.Background(), q)
	if result.State != "complete" || len(result.Diagnostics) == 0 || result.Diagnostics[0].Severity != "error" {
		t.Fatalf("diagnostics: %+v", result)
	}
}

func TestEditorCompletionAndOrganizeImports(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\nvar MyValue = 1\nfunc Read(){ _ = MyVa }\n")
	w := startFixture(t, root, "app")
	q := editorQuery{ID: "completion", Operation: "completion", Path: source, Position: &position{Line: 2, Character: 20}, WorkspaceGeneration: 1}
	result := w.editor(context.Background(), q)
	found := false
	for _, item := range result.Completions {
		if item.InsertText == "MyValue" {
			found = true
		}
	}
	if result.State != "complete" || !found {
		t.Fatalf("completion: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: source, Content: "package app\nimport \"fmt\"\nfunc Read(){}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	q.Operation = "codeActions"
	q.Position = nil
	q.DocumentRevision = 1
	result = w.editor(context.Background(), q)
	if result.State != "complete" || len(result.CodeActions) != 1 || result.CodeActions[0].Kind != "source.organizeImports" || len(result.CodeActions[0].Edits) == 0 {
		t.Fatalf("organize imports: %+v", result)
	}
}

func TestEditorRenameFederatesAndNeverMutatesFiles(t *testing.T) {
	root := t.TempDir()
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	source := put(t, root, "shared/shared.go", "package shared\nfunc Target() {}\n")
	first := fixtureConsumer(t, root, "first", "shared")
	second := fixtureConsumer(t, root, "second", "shared")
	w := startFixture(t, root, "shared", "first", "second")
	q := editorQuery{ID: "rename", Operation: "rename", Path: source, Position: &position{Line: 1, Character: 6}, NewName: "Renamed", WorkspaceGeneration: 1}
	result := w.editor(context.Background(), q)
	paths := map[string]bool{}
	for _, edit := range result.Edits {
		paths[edit.Path] = true
		if edit.FileHash == "" || edit.NewText != "Renamed" {
			t.Fatalf("edit: %+v", edit)
		}
	}
	if result.State != "complete" || len(result.Edits) != 3 || !paths[source] || !paths[first] || !paths[second] {
		t.Fatalf("rename coverage: %+v", result)
	}
	still := w.query(context.Background(), navigationQuery{ID: "still", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if len(still.Locations) != 2 {
		t.Fatalf("preview mutated source: %+v", still)
	}
	q.NewName = "privateName"
	result = w.editor(context.Background(), q)
	if result.State == "complete" || len(result.Edits) != 0 {
		t.Fatalf("rename made cross-package symbol inaccessible: %+v", result)
	}
	q.NewName = "Renamed"
	if err := w.update(context.Background(), documentUpdate{Path: first, Content: "package first\nimport \"fixture/shared\"\nvar broken MissingType\nfunc Call(){ shared.Target() }\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	result = w.editor(context.Background(), q)
	if result.State == "complete" || len(result.Edits) != 0 {
		t.Fatalf("partial rename edits exposed after context error: %+v", result)
	}
}

func TestWorkspaceChangedInvalidatesUnopenedFiles(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/target.go", "package app\nfunc Target() {}\n")
	caller := put(t, root, "app/caller.go", "package app\nfunc Caller(){Target()}\n")
	w := startFixture(t, root, "app")
	q := navigationQuery{ID: "refs", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	if result := w.query(context.Background(), q); len(result.Locations) != 1 {
		t.Fatalf("before change: %+v", result)
	}
	if err := os.WriteFile(caller, []byte("package app\nfunc Caller(){}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := w.changed(context.Background(), []string{caller}); err != nil {
		t.Fatal(err)
	}
	if result := w.query(context.Background(), q); result.State != "complete" || len(result.Locations) != 0 {
		t.Fatalf("stale disk content: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: caller, Content: "package app\nfunc Caller(){Target()}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	if err := w.changed(context.Background(), []string{caller}); err != nil {
		t.Fatal(err)
	}
	if result := w.query(context.Background(), q); result.State != "complete" || len(result.Locations) != 1 {
		t.Fatalf("watcher discarded unsaved overlay: %+v", result)
	}
	newFile := put(t, root, "app/new.go", "package app\nfunc Another(){Target()}\n")
	if err := w.changed(context.Background(), []string{newFile}); err != nil {
		t.Fatal(err)
	}
	if result := w.query(context.Background(), q); result.State != "complete" || len(result.Locations) != 2 {
		t.Fatalf("watcher missed new file: %+v", result)
	}
	if err := os.Remove(newFile); err != nil {
		t.Fatal(err)
	}
	if err := w.changed(context.Background(), []string{newFile}); err != nil {
		t.Fatal(err)
	}
	if result := w.query(context.Background(), q); result.State != "complete" || len(result.Locations) != 1 {
		t.Fatalf("watcher retained deleted file: %+v", result)
	}
}

func TestEditorRenameBlocksIncompleteMethodCoverageAndStaleDocuments(t *testing.T) {
	root := t.TempDir()
	put(t, root, "api/go.mod", "module fixture/api\n\ngo 1.25\n")
	source := put(t, root, "api/api.go", "package api\ntype Pinger interface { Ping() }\n")
	put(t, root, "impl/go.mod", "module fixture/impl\n\ngo 1.25\n")
	put(t, root, "impl/impl.go", "package impl\ntype Private struct{}\nfunc (Private) Ping() {}\n")
	w := startFixture(t, root, "api", "impl")
	q := editorQuery{ID: "rename", Operation: "rename", Path: source, Position: &position{Line: 1, Character: 25}, NewName: "Pong", WorkspaceGeneration: 1}
	result := w.editor(context.Background(), q)
	if result.State == "complete" || len(result.Edits) != 0 || len(result.Reasons) == 0 {
		t.Fatalf("unsafe method rename offered: %+v", result)
	}
	q.Operation = "format"
	q.DocumentRevision = 9
	if result = w.editor(context.Background(), q); result.State != "failed" || len(result.Edits) != 0 {
		t.Fatalf("stale edits offered: %+v", result)
	}
	q.DocumentRevision = 0
	q.Path = filepath.Join(root, "missing.go")
	if result = w.editor(context.Background(), q); result.State == "complete" {
		t.Fatalf("unknown source accepted: %+v", result)
	}
}

func TestEditorOrganizeVendoredImport(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\nrequire fixture/dependency v0.0.0\n")
	put(t, root, "app/vendor/modules.txt", "# fixture/dependency v0.0.0\n## explicit; go 1.25\nfixture/dependency\n")
	put(t, root, "app/vendor/fixture/dependency/dep.go", "package dependency\nfunc Target() {}\n")
	source := put(t, root, "app/main.go", "package app\nfunc Call(){dependency.Target()}\n")
	w := startFixture(t, root, "app")
	result := w.editor(context.Background(), editorQuery{ID: "imports", Operation: "codeActions", Path: source, WorkspaceGeneration: 1})
	found := false
	for _, action := range result.CodeActions {
		for _, edit := range action.Edits {
			if strings.Contains(edit.NewText, "fixture/dependency") {
				found = true
			}
		}
	}
	if result.State != "complete" || !found {
		t.Fatalf("vendored import not resolved: %+v", result)
	}
}
