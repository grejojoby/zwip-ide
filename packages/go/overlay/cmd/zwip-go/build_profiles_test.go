package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func startProfileFixture(t *testing.T, root string, contexts []buildContext) *worker {
	t.Helper()
	w := newWorker()
	t.Cleanup(w.close)
	states, err := w.initialize(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: contexts})
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

func TestSimultaneousGoBuildProfiles(t *testing.T) {
	root := t.TempDir()
	mod := put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	module := filepath.Dir(mod)
	commonText := "package app\nfunc Shared() {}\nfunc Call() string { Shared(); return Target() }\nfunc Port() string { return Platform() }\n"
	common := put(t, root, "app/common.go", commonText)
	base := put(t, root, "app/default.go", "//go:build !integration\n\npackage app\nfunc Target() string { return \"default\" }\nfunc DefaultCall() { Shared() }\n")
	tagged := put(t, root, "app/tagged.go", "//go:build integration\n\npackage app\nfunc Target() string { return \"integration\" }\nfunc TaggedCall() { Shared() }\n")
	crossOS := "linux"
	if runtime.GOOS == crossOS {
		crossOS = "windows"
	}
	nativeFile := put(t, root, "app/platform_"+runtime.GOOS+".go", "package app\nfunc Platform() string { return \"native\" }\n")
	crossFile := put(t, root, "app/platform_"+crossOS+".go", "package app\nfunc Platform() string { return \"cross\" }\n")
	// Deliberately supply a named profile first: implicit requests must still
	// choose the default context, independent of initialization order.
	w := startProfileFixture(t, root, []buildContext{
		{ID: "app#integration", ProfileID: "integration", Root: module, Language: "go", Settings: map[string]any{"tags": []string{"integration"}, "cgoEnabled": false}},
		{ID: "app#cross", ProfileID: "cross", Root: module, Language: "go", Settings: map[string]any{"goos": crossOS, "goarch": "amd64", "cgoEnabled": false}},
		{ID: "app", Root: module, Language: "go"},
	})
	ctx := context.Background()
	assertDefinition := func(profile, path string, line, char uint32, revision int32, expected string) {
		t.Helper()
		q := navigationQuery{ID: "definition", Operation: "definition", Path: path, Position: position{Line: line, Character: char}, DocumentRevision: revision, WorkspaceGeneration: 1, SourceContextID: profile}
		result := w.query(ctx, q)
		wantContext := profile
		if wantContext == "" {
			wantContext = "app"
		}
		if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Path != expected || !slices.Equal(result.Locations[0].ContextIDs, []string{wantContext}) {
			t.Fatalf("%s definition: %+v", profile, result)
		}
	}
	assertDefinition("", common, 2, 38, 0, base)
	assertDefinition("app#integration", common, 2, 38, 0, tagged)
	assertDefinition("", common, 3, 29, 0, nativeFile)
	assertDefinition("app#cross", common, 3, 29, 0, crossFile)
	refs := w.query(ctx, navigationQuery{ID: "refs", Operation: "references", Path: common, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1})
	if refs.State != "complete" || refs.TotalContexts != 3 || refs.SearchedContexts != 3 || len(refs.Locations) != 3 {
		t.Fatalf("profile union: %+v", refs)
	}
	for _, location := range refs.Locations {
		slices.Sort(location.ContextIDs)
		want := []string{"app", "app#cross", "app#integration"}
		if location.Path == base {
			want = []string{"app", "app#cross"}
		}
		if location.Path == tagged {
			want = []string{"app#integration"}
		}
		if !slices.Equal(location.ContextIDs, want) {
			t.Fatalf("profile provenance: %+v want %v", location, want)
		}
	}
	excluded := w.query(ctx, navigationQuery{ID: "excluded", Operation: "definition", Path: tagged, Position: position{Line: 3, Character: 6}, WorkspaceGeneration: 1})
	if excluded.State != "partial" || len(excluded.Locations) != 0 || !strings.Contains(strings.Join(excluded.Reasons, " "), "excluded") {
		t.Fatalf("excluded file silently loaded: %+v", excluded)
	}
	assertDefinition("app#integration", tagged, 3, 6, 0, tagged)
	sharedPosition := position{Line: 1, Character: 6}
	rename := w.editor(ctx, editorQuery{ID: "rename", Operation: "rename", Path: common, Position: &sharedPosition, WorkspaceGeneration: 1, NewName: "RenamedShared"})
	if rename.State != "complete" || len(rename.Edits) != 4 {
		t.Fatalf("profile rename union: %+v", rename)
	}
	conditionalPosition := position{Line: 3, Character: 6}
	rename = w.editor(ctx, editorQuery{ID: "rename-conditional", Operation: "rename", Path: tagged, Position: &conditionalPosition, WorkspaceGeneration: 1, SourceContextID: "app#integration", NewName: "RenamedTarget"})
	if rename.State != "failed" || len(rename.Edits) != 0 || !strings.Contains(strings.Join(rename.Reasons, " "), "different declaration") {
		t.Fatalf("unsafe conditional rename: %+v", rename)
	}
	// Opening and closing one overlay must preserve distinct upstream folders
	// and update every configured profile rather than collapsing by root.
	changed := strings.Replace(commonText, "return Target()", "return Platform()", 1)
	if err := w.update(ctx, documentUpdate{Path: common, Content: changed, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	assertDefinition("", common, 2, 38, 1, nativeFile)
	assertDefinition("app#cross", common, 2, 38, 1, crossFile)
	if err := w.update(ctx, documentUpdate{Path: common, Content: commonText, Revision: 2}); err != nil {
		t.Fatal(err)
	}
	assertDefinition("", common, 2, 38, 2, base)
	assertDefinition("app#integration", common, 2, 38, 2, tagged)
	if err := w.closeDocument(ctx, common); err != nil {
		t.Fatal(err)
	}
	assertDefinition("app#integration", common, 2, 38, 0, tagged)
	for _, method := range []string{"run.start", "test.start", "debug.start"} {
		result := toolCall(t, w, method, map[string]any{"contextId": "app#cross"})
		if result.State != "failed" || !strings.Contains(strings.Join(result.Reasons, " "), "native target") {
			t.Fatalf("cross-target execution %s: %+v", method, result)
		}
	}
	selected, err := w.toolContext("", common)
	if err != nil || selected.ID != "app" {
		t.Fatalf("implicit tool profile: %+v %v", selected, err)
	}
	data, _ := os.ReadFile(mod)
	if string(data) != "module fixture/app\n\ngo 1.25\n" {
		t.Fatal("module file changed")
	}
	if _, err := os.Stat(filepath.Join(root, "go.work")); !os.IsNotExist(err) {
		t.Fatal("synthetic workspace file created")
	}
}

func TestBuildProfileValidation(t *testing.T) {
	for name, settings := range map[string]map[string]any{
		"unknown": {"arbitraryEnvironment": "value"}, "bad target": {"goos": "linux x"},
		"null target": {"goarch": nil}, "empty target": {"goos": ""}, "numeric target": {"goarch": 64},
		"string cgo": {"cgoEnabled": "false"}, "null cgo": {"cgoEnabled": nil},
		"string tags": {"tags": "integration"}, "null tags": {"tags": nil},
		"bad tags": {"tags": []string{"integration,bad"}}, "duplicate tags": {"tags": []string{"x", "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseGoBuildSettings(settings); err == nil {
				t.Fatalf("accepted %+v", settings)
			}
		})
	}
	root := t.TempDir()
	mod := put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	put(t, root, "app/app.go", "package app\n")
	w := newWorker()
	defer w.close()
	_, err := w.initializeAsync(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: []buildContext{{ID: "app#invalid", ProfileID: "invalid", Root: filepath.Dir(mod), Language: "go", Settings: map[string]any{"goos": "darwin", "goarch": "wasm"}}}})
	if err == nil || !strings.Contains(err.Error(), "unsupported Go target darwin/wasm") {
		t.Fatalf("invalid pair: %v", err)
	}
}

func TestGoBuildProfileToolsPreserveExplicitWorkspace(t *testing.T) {
	root := t.TempDir()
	work := put(t, root, "go.work", "go 1.25\nuse ./app\n")
	mod := put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	put(t, root, "app/default.go", "//go:build !integration\n\npackage app\nconst Mode = \"default\"\n")
	put(t, root, "app/tagged.go", "//go:build integration\n\npackage app\nconst Mode = \"integration\"\n")
	put(t, root, "app/app_test.go", "package app\nimport \"testing\"\nfunc TestMode(t *testing.T) { if Mode != \"integration\" { t.Fatal(Mode) } }\n")
	w := startProfileFixture(t, root, []buildContext{
		{ID: "app", Root: filepath.Dir(mod), Language: "go"},
		{ID: "app#integration", ProfileID: "integration", Root: filepath.Dir(mod), Language: "go", Settings: map[string]any{"tags": []string{"integration"}, "cgoEnabled": false}},
	})
	for _, c := range w.contexts {
		if c.GoWork != work {
			t.Fatalf("workfile lost: %+v", c)
		}
	}
	job := toolCall(t, w, "test.start", map[string]any{"contextId": "app#integration"})
	if job.State != "complete" || job.Job == nil {
		t.Fatalf("%+v", job)
	}
	deadline := time.Now().Add(30 * time.Second)
	for job.Job.Status == "running" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		job = toolCall(t, w, "job.poll", map[string]any{"jobId": job.Job.ID})
	}
	if job.Job.Status != "completed" {
		t.Fatalf("profile test: %+v", job.Job)
	}
	if _, err := os.Stat(work + ".sum"); !os.IsNotExist(err) {
		t.Fatalf("workspace checksum mutated: %v", err)
	}
	// An explicit empty tag list overrides inherited GOFLAGS tags.
	t.Setenv("GOFLAGS", "-tags=integration")
	settings, err := parseGoBuildSettings(map[string]any{"tags": []string{}})
	if err != nil {
		t.Fatal(err)
	}
	flags := contextBuildFlags(buildContext{Root: filepath.Dir(mod), profile: settings})
	if !slices.Contains(flags, "-tags=") {
		t.Fatalf("empty tags did not override ambient flags: %v", flags)
	}
}

func TestDebugLaunchCannotChangeBuildProfileThroughEnvironment(t *testing.T) {
	t.Setenv("CGO_ENABLED", "0")
	t.Setenv("GOFLAGS", "")
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package main\nfunc main(){}\n")
	w := startFixture(t, root, "app")
	selected, err := w.toolContext("app", source)
	if err != nil {
		t.Fatal(err)
	}
	session := debugSession{context: selected, dir: t.TempDir()}
	args, err := session.launchArguments(map[string]any{"program": source, "env": map[string]any{
		"GOFLAGS": "-tags=unexpected", "GOENV": "/unexpected-go-env", "CGO_ENABLED": "1",
		"GOOS": "windows", "GOARCH": "386", "GOEXPERIMENT": "unexpected", "APP_VALUE": "preserved",
	}})
	if err != nil {
		t.Fatal(err)
	}
	env := args["env"].(map[string]any)
	if env["GOFLAGS"] == "-tags=unexpected" || env["GOENV"] == "/unexpected-go-env" || env["CGO_ENABLED"] != "0" || env["GOEXPERIMENT"] == "unexpected" || env["GOOS"] != runtime.GOOS || env["GOARCH"] != runtime.GOARCH || env["APP_VALUE"] != "preserved" {
		t.Fatalf("debug environment changed selected build profile: %+v", env)
	}
	if args["program"] != filepath.Dir(source) {
		t.Fatalf("source-file launch dropped package siblings: %v", args["program"])
	}
}

func TestDebugLaunchPreservesContainedWorkingDirectory(t *testing.T) {
	root, err := canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source := put(t, root, "cmd/server/main.go", "package main\nfunc main(){}\n")
	config := put(t, root, "runtime/settings.json", "{}")
	cwd := filepath.Dir(config)
	session := debugSession{context: buildContext{Root: root}, dir: t.TempDir()}
	args, err := session.launchArguments(map[string]any{"program": source, "cwd": cwd})
	if err != nil {
		t.Fatal(err)
	}
	if args["cwd"] != cwd || args["dlvCwd"] != root || args["program"] != filepath.Dir(source) {
		t.Fatalf("launch lost requested cwd or changed build root: %+v", args)
	}
	args, err = session.launchArguments(map[string]any{"program": source})
	if err != nil || args["cwd"] != root {
		t.Fatalf("default cwd changed: %+v %v", args, err)
	}
	outside := t.TempDir()
	link := filepath.Join(root, "external")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []any{outside, link, config, "runtime", filepath.Join(root, "missing"), 42, ""} {
		if _, err := session.launchArguments(map[string]any{"program": source, "cwd": invalid}); err == nil {
			t.Errorf("invalid debug cwd accepted: %v", invalid)
		}
	}
}

func TestBrokenGoProfileDoesNotFallbackAndBlocksRename(t *testing.T) {
	t.Setenv("GOPROXY", "off")
	root := t.TempDir()
	mod := put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/common.go", "package app\nfunc Call(){Target()}\n")
	base := put(t, root, "app/base.go", "//go:build !broken\n\npackage app\nfunc Target(){}\n")
	broken := put(t, root, "app/broken.go", "//go:build broken\n\npackage app\nimport \"fixture/missing\"\nfunc Target(){missing.X()}\n")
	w := newWorker()
	defer w.close()
	_, err := w.initialize(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: []buildContext{
		{ID: "app#broken", ProfileID: "broken", Root: filepath.Dir(mod), Language: "go", Settings: map[string]any{"tags": []string{"broken"}}},
		{ID: "app", Root: filepath.Dir(mod), Language: "go"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	q := navigationQuery{ID: "definition", Operation: "definition", Path: source, Position: position{Line: 1, Character: 13}, WorkspaceGeneration: 1}
	defaultResult := w.query(context.Background(), q)
	if defaultResult.State != "complete" || len(defaultResult.Locations) != 1 || defaultResult.Locations[0].Path != base {
		t.Fatalf("broken profile poisoned default: %+v", defaultResult)
	}
	q.SourceContextID = "app#broken"
	result := w.query(context.Background(), q)
	if result.State != "partial" && result.State != "failed" || len(result.Reasons) == 0 {
		t.Fatalf("broken profile advertised complete: %+v", result)
	}
	for _, location := range result.Locations {
		if location.Path != broken {
			t.Fatalf("silently fell back to default: %+v", result)
		}
	}
	pos := position{Line: 3, Character: 6}
	rename := w.editor(context.Background(), editorQuery{ID: "rename", Operation: "rename", Path: base, Position: &pos, WorkspaceGeneration: 1, NewName: "Changed"})
	if rename.State != "failed" || len(rename.Edits) != 0 {
		t.Fatalf("rename ignored broken profile: %+v", rename)
	}
}
