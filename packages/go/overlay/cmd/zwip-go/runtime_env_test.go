package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPackageCacheBootstrapSubprocess(t *testing.T) {
	if os.Getenv("ZWIP_TEST_PACKAGE_CACHE_CHILD") == "1" {
		if err := configurePackageCache(); err != nil {
			t.Fatal(err)
		}
		cache := os.Getenv("ZWIP_PACKAGE_CACHE")
		if os.Getenv("GOPLSCACHE") != filepath.Join(cache, "gopls") || os.Getenv("GOCACHE") != filepath.Join(cache, "go-build") {
			t.Fatal("generic cache not mapped")
		}
		root := t.TempDir()
		put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
		source := put(t, root, "app/main.go", "package app\nfunc Target(){}\nfunc Call(){Target()}\n")
		w := startFixture(t, root, "app")
		result := w.query(context.Background(), navigationQuery{ID: "q", Operation: "definition", Path: source, Position: position{Line: 2, Character: 13}, WorkspaceGeneration: 1})
		if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Range.Start.Line != 1 {
			t.Fatalf("generic cache navigation: %+v", result)
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cache := t.TempDir()
	command := exec.Command(executable, "-test.run=^TestPackageCacheBootstrapSubprocess$")
	command.Env = append(os.Environ(), "ZWIP_TEST_PACKAGE_CACHE_CHILD=1", "ZWIP_PACKAGE_CACHE="+cache, "GOPLSCACHE=/unavailable-zwip-go-cache", "GOCACHE=/unavailable-zwip-go-build-cache")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("cache bootstrap: %s %v", output, err)
	}
	for _, name := range []string{"gopls", "go-build"} {
		if _, err := os.Stat(filepath.Join(cache, name)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPackageCacheExplicitFallbackAndValidation(t *testing.T) {
	t.Setenv("ZWIP_PACKAGE_CACHE", "")
	t.Setenv("GOPLSCACHE", "/explicit/gopls")
	t.Setenv("GOCACHE", "/explicit/go-build")
	if err := configurePackageCache(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("GOPLSCACHE") != "/explicit/gopls" || os.Getenv("GOCACHE") != "/explicit/go-build" {
		t.Fatal("direct invocation cache overrides changed")
	}
	t.Setenv("ZWIP_PACKAGE_CACHE", "relative")
	if err := configurePackageCache(); err == nil {
		t.Fatal("accepted relative package cache")
	}
}
