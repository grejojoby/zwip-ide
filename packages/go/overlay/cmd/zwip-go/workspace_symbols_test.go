package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestWorkspaceSymbolsAcrossModulesAndOverlay(t *testing.T) {
	root := t.TempDir()
	for _, module := range []string{"first", "second"} {
		put(t, root, module+"/go.mod", "module fixture/"+module+"\n\ngo 1.25\n")
		put(t, root, module+"/main.go", "package "+module+"\nfunc SearchTarget(){}\n")
	}
	w := startFixture(t, root, "first", "second")
	query := workspaceSymbolQuery{ID: "symbols", Query: "SearchTarget", WorkspaceGeneration: 1}
	result := w.workspaceSymbols(context.Background(), query)
	if result.State != "complete" || len(result.Locations) != 2 || result.SearchedContexts != 2 || result.DocumentRevision != 0 {
		t.Fatalf("%+v", result)
	}
	path := result.Locations[0].Path
	if err := w.update(context.Background(), documentUpdate{Path: path, Content: "package first\nfunc UnsavedTarget(){}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	query.Query = "UnsavedTarget"
	result = w.workspaceSymbols(context.Background(), query)
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != path {
		t.Fatalf("%+v", result)
	}
	query.WorkspaceGeneration = 2
	if result = w.workspaceSymbols(context.Background(), query); result.State != "failed" {
		t.Fatalf("obsolete generation accepted: %+v", result)
	}
}

func TestWorkspaceSymbolsReportTruncation(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	var code strings.Builder
	code.WriteString("package app\n")
	for i := 0; i < 120; i++ {
		fmt.Fprintf(&code, "func SearchTarget%d(){}\n", i)
	}
	put(t, root, "app/main.go", code.String())
	w := startFixture(t, root, "app")
	result := w.workspaceSymbols(context.Background(), workspaceSymbolQuery{ID: "symbols", Query: "SearchTarget", WorkspaceGeneration: 1})
	if result.State != "partial" || len(result.Locations) != 100 || len(result.Reasons) == 0 {
		t.Fatalf("%+v", result)
	}
}
