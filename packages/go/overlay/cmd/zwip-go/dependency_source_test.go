package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestDependencySourceNavigationPreservesPhysicalContext(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	var dependencies []string
	for _, name := range []string{"first", "second"} {
		dependency := filepath.Join(outside, name)
		put(t, dependency, "go.mod", "module example.org/dependency\n\ngo 1.25\n")
		dependencies = append(dependencies, put(t, dependency, "dep.go", "package dependency\nfunc Target(){}\nfunc Local(){Target()}\n"))
		put(t, root, name+"/go.mod", fmt.Sprintf("module fixture/%s\n\ngo 1.25\nrequire example.org/dependency v0.0.0\nreplace example.org/dependency => %s\n", name, filepath.ToSlash(dependency)))
		put(t, root, name+"/app.go", "package app\nimport \"example.org/dependency\"\nfunc Call(){dependency.Target()}\n")
	}
	w := startFixture(t, root, "first", "second")
	query := navigationQuery{ID: "external-definition", Path: dependencies[0], Operation: "definition", Position: position{Line: 2, Character: 13}, WorkspaceGeneration: 1, SourceContextID: "first"}
	result := w.query(context.Background(), query)
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != dependencies[0] {
		t.Fatalf("external definition: %+v", result)
	}
	query.Operation, query.Position = "references", position{Line: 1, Character: 6}
	result = w.query(context.Background(), query)
	if result.State != "complete" || len(result.Locations) != 1 {
		t.Fatalf("external references: %+v", result)
	}
	for _, location := range result.Locations {
		if location.Path == dependencies[1] || strings.Contains(location.Path, "/second/") {
			t.Fatalf("same import path conflated different physical dependencies: %+v", result)
		}
	}
	query.SourceContextID = "second"
	result = w.query(context.Background(), query)
	if result.State == "complete" || len(result.Locations) != 0 {
		t.Fatalf("wrong provenance accepted: %+v", result)
	}
	query.SourceContextID = ""
	result = w.query(context.Background(), query)
	if result.State != "complete" || len(result.Locations) != 1 {
		t.Fatalf("exact metadata fallback: %+v", result)
	}
	pos := position{Line: 1, Character: 6}
	hover := w.editor(context.Background(), editorQuery{ID: "hover", Path: dependencies[0], Operation: "hover", Position: &pos, WorkspaceGeneration: 1, SourceContextID: "first"})
	if hover.State != "complete" || !strings.Contains(hover.Hover, "Target") {
		t.Fatalf("external hover: %+v", hover)
	}
	for _, operation := range []string{"rename", "format", "completion", "codeActions"} {
		edits := w.editor(context.Background(), editorQuery{ID: operation, Path: dependencies[0], Operation: operation, Position: &pos, NewName: "Changed", WorkspaceGeneration: 1, SourceContextID: "first"})
		if edits.State != "failed" || len(edits.Edits) != 0 || len(edits.CodeActions) != 0 || len(edits.Completions) != 0 {
			t.Fatalf("external edits exposed: %+v", edits)
		}
	}
	if err := w.update(context.Background(), documentUpdate{Path: dependencies[0], Content: "package changed", Revision: 1}); err == nil {
		t.Fatal("dependency overlay accepted")
	}
	query.Path = put(t, outside, "unrelated.go", "package unrelated\nfunc Target(){}\n")
	result = w.query(context.Background(), query)
	if result.State == "complete" || len(result.Locations) != 0 {
		t.Fatalf("unrelated external file accepted: %+v", result)
	}
}

func TestRenameIncludedDependencyThroughAbsoluteReplace(t *testing.T) {
	root := t.TempDir()
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	source := put(t, root, "shared/shared.go", "package shared\nfunc Target(){}\n")
	// t.TempDir may use the /var spelling while source is /private/var.
	put(t, root, "app/go.mod", fmt.Sprintf("module fixture/app\n\ngo 1.25\nrequire fixture/shared v0.0.0\nreplace fixture/shared => %s\n", filepath.ToSlash(filepath.Join(root, "shared"))))
	consumer := put(t, root, "app/main.go", "package app\nimport \"fixture/shared\"\nfunc Call(){shared.Target()}\n")
	w := startFixture(t, root, "shared", "app")
	position := position{Line: 1, Character: 6}
	result := w.editor(context.Background(), editorQuery{ID: "rename", Operation: "rename", Path: source, Position: &position, NewName: "Renamed", WorkspaceGeneration: 1})
	if result.State != "complete" || len(result.Edits) != 2 {
		t.Fatalf("rename omitted a physical alias context: %+v", result)
	}
	seen := map[string]bool{}
	for _, edit := range result.Edits {
		seen[edit.Path] = true
	}
	if !seen[source] || !seen[consumer] {
		t.Fatalf("rename omitted included source: %+v", result)
	}
}
