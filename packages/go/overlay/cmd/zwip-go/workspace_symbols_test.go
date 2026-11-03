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

func TestWorkspaceSymbolsFindPackageDeclarations(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	put(t, root, "app/main.go", "package app\n")
	// A package name can differ from its directory, and several files declare it.
	put(t, root, "app/transport/first.go", "// Package clientip handles addresses.\npackage clientip\nfunc Resolve(){}\n")
	put(t, root, "app/transport/second.go", "package clientip\n")
	w := startFixture(t, root, "app")
	query := workspaceSymbolQuery{ID: "packages", Query: "CLIENTIP", WorkspaceGeneration: 1}
	result := w.workspaceSymbols(context.Background(), query)
	var packages []sourceLocation
	for _, location := range result.Locations {
		if location.Relationship == "package" {
			packages = append(packages, location)
		}
	}
	if result.State != "complete" || len(packages) != 1 {
		t.Fatalf("package name search: %+v", result)
	}
	location := packages[0]
	if location.Name != "clientip" || !strings.HasSuffix(location.Path, "/transport/first.go") || location.Range.Start.Line != 1 || location.Range.Start.Character != 8 || location.Range.End.Character != 16 {
		t.Fatalf("package declaration target: %+v", location)
	}
	// Import paths find the same package, even when they differ from its name.
	query.Query = "fixture/app/transport"
	result = w.workspaceSymbols(context.Background(), query)
	packages = nil
	for _, location := range result.Locations {
		if location.Relationship == "package" {
			packages = append(packages, location)
		}
	}
	if result.State != "complete" || len(packages) != 1 || packages[0].Path != location.Path {
		t.Fatalf("package import-path search: %+v", result)
	}
}
