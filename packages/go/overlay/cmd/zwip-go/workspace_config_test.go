package main

import (
	"archive/zip"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExplicitGoWorkNavigationAndTools(t *testing.T) {
	root := t.TempDir()
	work := put(t, root, "go.work", "go 1.25\nuse (\n ./shared\n ./app\n)\n")
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	declaration := put(t, root, "shared/shared.go", "package shared\nfunc Target()int{return 42}\n")
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\nrequire fixture/shared v0.0.0\n")
	source := put(t, root, "app/app.go", "package app\nimport \"fixture/shared\"\nfunc Call()int{return shared.Target()}\n")
	put(t, root, "app/app_test.go", "package app\nimport \"testing\"\nfunc TestCall(t *testing.T){if Call()!=42{t.Fatal(\"bad\")}}\n")
	put(t, root, "independent/go.mod", "module fixture/independent\n\ngo 1.25\n")
	put(t, root, "independent/main.go", "package independent\nfunc Alone(){}\n")
	w := startFixture(t, root, "shared", "app", "independent")
	for _, c := range w.contexts {
		if c.ID == "independent" {
			if c.GoWork != "" {
				t.Fatalf("unlisted module forced into workspace: %+v", c)
			}
		} else if c.GoWork != work {
			t.Fatalf("explicit workspace missed: %+v", c)
		}
	}
	result := w.query(context.Background(), navigationQuery{ID: "definition", Operation: "definition", Path: source, Position: position{Line: 2, Character: 29}, WorkspaceGeneration: 1})
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != declaration {
		t.Fatalf("workspace definition: %+v", result)
	}
	refs := w.query(context.Background(), navigationQuery{ID: "refs", Operation: "references", Path: declaration, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if refs.State != "complete" || len(refs.Locations) != 1 || refs.Locations[0].Path != source {
		t.Fatalf("workspace refs: %+v", refs)
	}
	job := toolCall(t, w, "test.start", map[string]any{"path": source})
	if job.State != "complete" || job.Job == nil {
		t.Fatalf("%+v", job)
	}
	deadline := time.Now().Add(30 * time.Second)
	for job.Job.Status == "running" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		job = toolCall(t, w, "job.poll", map[string]any{"jobId": job.Job.ID})
	}
	if job.Job.Status != "completed" {
		t.Fatalf("workspace test: %+v", job.Job)
	}
	content, _ := os.ReadFile(work)
	if string(content) != "go 1.25\nuse (\n ./shared\n ./app\n)\n" {
		t.Fatal("go.work mutated")
	}
	if _, err := os.Stat(filepath.Join(root, "go.work.sum")); !os.IsNotExist(err) {
		t.Fatalf("unexpected go.work.sum mutation: %v", err)
	}
}

func TestGoWorkDiscoveryBoundariesAndInvalidFiles(t *testing.T) {
	outer := t.TempDir()
	root := filepath.Join(outer, "project")
	put(t, outer, "go.work", "go 1.25\nuse ./project/app\n")
	moduleFile := put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	module := filepath.Dir(moduleFile)
	canonicalRoot, _ := canonical(root)
	if found, err := discoverGoWork(canonicalRoot, module); err != nil || found != "" {
		t.Fatalf("ancestor outside workspace was inherited: %q %v", found, err)
	}
	put(t, root, "go.work", "invalid workfile\n")
	if _, err := discoverGoWork(canonicalRoot, module); err == nil || !strings.Contains(err.Error(), "parse") {
		t.Fatalf("invalid explicit configuration ignored: %v", err)
	}
}

func TestGoWorkSumProtectionWithMissingChecksums(t *testing.T) {
	root := t.TempDir()
	proxy := t.TempDir()
	put(t, proxy, "example.org/dependency/@v/v0.0.1.mod", "module example.org/dependency\n\ngo 1.25\n")
	put(t, proxy, "example.org/dependency/@v/v0.0.1.info", `{"Version":"v0.0.1","Time":"2026-01-01T00:00:00Z"}`)
	archive, err := os.Create(filepath.Join(proxy, "example.org/dependency/@v/v0.0.1.zip"))
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(archive)
	for name, content := range map[string]string{"go.mod": "module example.org/dependency\n\ngo 1.25\n", "dep.go": "package dependency\nfunc Target(){}\n"} {
		entry, err := writer.Create("example.org/dependency@v0.0.1/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	archive.Close()
	t.Setenv("GOPROXY", "file://"+filepath.ToSlash(proxy))
	t.Setenv("GOSUMDB", "off")
	t.Setenv("GONOPROXY", "none")
	t.Setenv("GOMODCACHE", t.TempDir())
	moduleCache := os.Getenv("GOMODCACHE")
	t.Cleanup(func() {
		_ = filepath.WalkDir(moduleCache, func(path string, entry os.DirEntry, err error) error {
			if err == nil && entry.IsDir() {
				_ = os.Chmod(path, 0755)
			}
			return nil
		})
	})
	work := put(t, root, "go.work", "go 1.25\nuse ./app\n")
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\nrequire example.org/dependency v0.0.1\n")
	source := put(t, root, "app/app.go", "package app\nimport \"example.org/dependency\"\nfunc Valid(){dependency.Target()}\n")
	w := newWorker()
	defer w.close()
	contexts, err := w.initialize(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: []buildContext{{ID: "app", Root: filepath.Dir(source), Language: "go"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(work + ".sum"); !os.IsNotExist(err) {
		t.Fatalf("indexing mutated go.work.sum: %v", err)
	}
	// Verify the same protection survives both plain command invocations and
	// gopls's separately generated overlay for an unsaved Go document.
	args := append([]string{"list"}, contextBuildFlags(w.contexts[0])...)
	args = append(args, "-deps", "./...")
	cmd := exec.Command(defaultGo, args...)
	cmd.Dir = filepath.Dir(source)
	cmd.Env = toolEnvironment(w.contexts[0])
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "overlay") {
		t.Fatalf("expected protected checksum update error, contexts=%+v output=%s err=%v", contexts, output, err)
	}
	if err := w.update(context.Background(), documentUpdate{Path: source, Content: "package app\nimport \"example.org/dependency\"\nfunc Unsaved(){dependency.Target()}\n", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	w.workspaceSymbols(context.Background(), workspaceSymbolQuery{ID: "symbols", Query: "Unsaved", WorkspaceGeneration: 1})
	if _, err := os.Stat(work + ".sum"); !os.IsNotExist(err) {
		t.Fatalf("unsaved indexing mutated go.work.sum: %v", err)
	}
	// The control proves this fixture really needs a checksum write even in
	// readonly workspace mode; the protected paths above were not a no-op.
	control := exec.Command(defaultGo, "list", "-mod=readonly", "-deps", "./...")
	control.Dir = filepath.Dir(source)
	control.Env = toolEnvironment(w.contexts[0])
	if output, err := control.CombinedOutput(); err != nil {
		t.Fatalf("control: %s %v", output, err)
	}
	if _, err := os.Stat(work + ".sum"); err != nil {
		t.Fatalf("control did not write expected go.work.sum: %v", err)
	}
}
