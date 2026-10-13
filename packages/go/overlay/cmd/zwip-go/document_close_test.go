package main

import (
	"context"
	"os"
	"testing"
)

func TestCloseDocumentReleasesCleanOverlay(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	path := put(t, root, "app/main.go", "package app\nfunc Original(){}\n")
	w := startFixture(t, root, "app")
	text := "package app\nfunc Updated(){}\n"
	if err := w.update(context.Background(), documentUpdate{Path: path, Content: text, Revision: 5}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("package app\nfunc ExternalChange(){}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := w.closeDocument(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	if len(w.documents) != 0 {
		t.Fatal("closed overlay retained")
	}
	result := w.query(context.Background(), navigationQuery{ID: "definition", Operation: "definition", Path: path, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Name != "ExternalChange" {
		t.Fatalf("disk source after close: %+v", result)
	}
	if err := w.update(context.Background(), documentUpdate{Path: path, Content: text, Revision: 6}); err != nil {
		t.Fatal(err)
	}
	if err := w.closeDocument(context.Background(), path); err != nil {
		t.Fatal(err)
	}
}
