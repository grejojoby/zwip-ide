package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAsyncContextReadinessAndPriority(t *testing.T) {
	root := t.TempDir()
	var contexts []buildContext
	for i := range 7 {
		name := fmt.Sprintf("module%d", i)
		put(t, root, name+"/go.mod", "module fixture/"+name+"\n\ngo 1.25\n")
		put(t, root, name+"/main.go", "package fixture\nfunc Target(){}\nfunc Caller(){Target()}\n")
		contexts = append(contexts, buildContext{ID: name, Root: filepath.Join(root, name), Language: "go"})
	}
	w := newWorker()
	defer w.close()
	started := time.Now()
	states, err := w.initializeAsync(context.Background(), initializeParams{Root: root, Contexts: contexts, Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("initialize blocked on indexing")
	}
	for _, c := range states {
		if c.State != "loading" {
			t.Fatalf("asynchronous initialization skipped loading status: %+v", states)
		}
	}
	path := filepath.Join(root, "module6/main.go")
	result := w.query(context.Background(), navigationQuery{ID: "early", Operation: "definition", Path: path, Position: position{Line: 2, Character: 14}, WorkspaceGeneration: 1})
	if result.State != "partial" || result.SearchedContexts != 0 || len(result.Locations) != 0 || !strings.Contains(strings.Join(result.Reasons, " "), "loading") {
		t.Fatalf("loading query misrepresented coverage: %+v", result)
	}
	w.mu.Lock()
	queue := append([]int(nil), w.initialization.queue...)
	w.mu.Unlock()
	for index, queued := range queue {
		if queued == 6 && index != 0 {
			t.Fatalf("interactive module was not promoted: %v", queue)
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		status := w.status()
		active, queued := 0, 0
		for _, c := range status.Contexts {
			if c.State == "loading" {
				queued++
			}
			if c.Reason == "background indexing in progress" {
				active++
			}
		}
		if active > 2 {
			t.Fatalf("unbounded context loading: %+v", status)
		}
		if queued == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("contexts never became ready: %+v", status)
		}
		time.Sleep(5 * time.Millisecond)
	}
	result = w.query(context.Background(), navigationQuery{ID: "ready", Operation: "definition", Path: path, Position: position{Line: 2, Character: 14}, WorkspaceGeneration: 1})
	if result.State != "complete" || len(result.Locations) != 1 {
		t.Fatalf("ready query: %+v", result)
	}
}

func TestCloseWhileContextsAreLoading(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	put(t, root, "app/main.go", "package app\nimport \"net/http\"\nvar Client http.Client\n")
	w := newWorker()
	_, err := w.initializeAsync(context.Background(), initializeParams{Root: root, Generation: 1, Contexts: []buildContext{{ID: "app", Root: filepath.Join(root, "app"), Language: "go"}}})
	if err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	loading := w.initialization
	w.mu.Unlock()
	w.close()
	select {
	case <-loading.done:
	default:
		t.Fatal("background loader survived worker close")
	}
}
