package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceIndexAcrossProcesses(t *testing.T) {
	if root := os.Getenv("ZWIP_TEST_INDEX_ROOT"); root != "" {
		w := startFixture(t, root, "app")
		w.indexWorkspace()
		deadline := time.Now().Add(30 * time.Second)
		for {
			got := w.status().Contexts[0]
			if got.IndexState == "failed" {
				t.Fatalf("checkpoint: %+v", got)
			}
			if got.Indexed == got.Packages && got.Packages > 0 {
				if got.IndexState != "built" && got.IndexState != "restored" {
					continue
				}
				expected := os.Getenv("ZWIP_TEST_INDEX_EXPECT")
				if got.IndexState != expected {
					t.Fatalf("expected %s semantic index: %+v", expected, got)
				}
				if os.Getenv("ZWIP_TEST_INDEX_METADATA") == "restored" && !got.MetadataRestored {
					t.Fatalf("package graph was rebuilt: %+v", got)
				}
				if os.Getenv("ZWIP_TEST_INDEX_METADATA") == "rebuilt" && got.MetadataRestored {
					t.Fatalf("changed graph incorrectly restored: %+v", got)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("indexing timed out: %+v", got)
			}
			time.Sleep(25 * time.Millisecond)
		}
		query := navigationQuery{ID: "restored-definition", Operation: "definition", Path: filepath.Join(root, "app/main.go"), Position: position{Line: 2, Character: 31}, WorkspaceGeneration: 1}
		result := w.query(context.Background(), query)
		if result.State != "complete" || len(result.Locations) != 1 || !strings.HasSuffix(result.Locations[0].Path, "store/store.go") {
			t.Fatalf("restored navigation: %+v", result)
		}
		return
	}
	root := t.TempDir()
	cache := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/store/store.go", "package store\nfunc Get() int { return 1 }\n")
	put(t, root, "app/main.go", "package app\nimport \"fixture/app/store\"\nfunc Use() int { return store.Get() }\n")
	// Tests produce a generated test-main in GOCACHE on a cold load. It must
	// not prevent publishing the original source graph's validated checkpoint.
	put(t, root, "app/main_test.go", "package app\nimport \"testing\"\nfunc TestUse(t *testing.T) { if Use() < 0 { t.Fatal(\"negative\") } }\n")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	run := func(expected, metadata string) {
		t.Helper()
		command := exec.Command(binary, "-test.run=^TestWorkspaceIndexAcrossProcesses$", "-test.v")
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "GOPLSCACHE=") {
				command.Env = append(command.Env, entry)
			}
		}
		command.Env = append(command.Env, "GOPLSCACHE="+cache, "ZWIP_TEST_INDEX_ROOT="+root, "ZWIP_TEST_INDEX_EXPECT="+expected, "ZWIP_TEST_INDEX_METADATA="+metadata)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("%s: %s: %v", expected, output, err)
		}
	}
	run("built", "")
	run("restored", "restored")
	info, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	put(t, root, "app/store/store.go", "package store\nfunc Get() int { return 2 }\n")
	if err := os.Chtimes(source, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	run("built", "")
	run("restored", "restored")
	put(t, root, "app/store/extra.go", "package store\nfunc Extra() int { return Get() }\n")
	run("built", "")
	run("restored", "restored")
	if err := os.Rename(filepath.Join(root, "app/store/extra.go"), filepath.Join(root, "app/store/renamed.go")); err != nil {
		t.Fatal(err)
	}
	run("built", "")
	if err := os.Remove(filepath.Join(root, "app/store/renamed.go")); err != nil {
		t.Fatal(err)
	}
	// Deleting the extra file returns to an earlier exact content key: reusing
	// those artifacts is valid, but the package graph must still be reloaded.
	run("restored", "rebuilt")
	run("restored", "restored")
	if err := os.RemoveAll(cache); err != nil {
		t.Fatal(err)
	}
	run("built", "")
}
