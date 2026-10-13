package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestNavigationProgressIsCumulativeSourceFirstAndImmutable(t *testing.T) {
	root := t.TempDir()
	put(t, root, "shared/go.mod", "module fixture/shared\n\ngo 1.25\n")
	source := put(t, root, "shared/shared.go", "package shared\nfunc Target() {}\nfunc Local() { Target() }\n")
	for _, name := range []string{"a", "b"} {
		put(t, root, name+"/go.mod", fmt.Sprintf("module fixture/%s\n\ngo 1.25\nrequire fixture/shared v0.0.0\nreplace fixture/shared => ../shared\n", name))
		put(t, root, name+"/main.go", "package consumer\nimport \"fixture/shared\"\nfunc Use() { shared.Target() }\n")
	}
	w := startFixture(t, root, "a", "b", "shared")
	query := navigationQuery{ID: "progress", Operation: "references", Path: source, Position: position{Line: 1, Character: 6}, WorkspaceGeneration: 1}
	var batches []navigationBatch
	var encoded [][]byte
	final := w.queryProgress(context.Background(), query, func(batch navigationBatch) {
		if batch.State != "loading" || batch.ID != query.ID || batch.WorkspaceGeneration != query.WorkspaceGeneration || batch.DocumentRevision != query.DocumentRevision {
			t.Fatalf("progress identity: %+v", batch)
		}
		batches = append(batches, batch)
		bytes, _ := json.Marshal(batch)
		encoded = append(encoded, bytes)
	})
	if final.State != "complete" || final.SearchedContexts != 3 || len(final.Locations) != 3 || len(batches) != 3 {
		t.Fatalf("final: %+v, progress batches: %d", final, len(batches))
	}
	if len(batches[0].Locations) != 1 || batches[0].Locations[0].Path != source || batches[0].Locations[0].ContextIDs[0] != "shared" {
		t.Fatalf("originating context was not published first: %+v", batches[0])
	}
	for index, batch := range batches {
		if batch.SearchedContexts != index+1 || batch.TotalContexts != 3 || len(batch.Locations) != index+1 {
			t.Fatalf("nonincremental batch %d: %+v", index, batch)
		}
		current, _ := json.Marshal(batch)
		if string(current) != string(encoded[index]) {
			t.Fatal("later context mutated an already published batch")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	count := 0
	canceled := w.queryProgress(ctx, query, func(navigationBatch) { count++; cancel() })
	if canceled.State != "canceled" || count != 1 || canceled.SearchedContexts != 1 {
		t.Fatalf("continued after cancellation: %+v, batches=%d", canceled, count)
	}
	count = 0
	stale := w.queryProgress(context.Background(), query, func(navigationBatch) {
		count++
		if err := w.update(context.Background(), documentUpdate{Path: source, Revision: 1, Content: "package shared\nfunc Target() {}\nfunc NewLocal() { Target() }\n"}); err != nil {
			t.Fatal(err)
		}
	})
	if stale.State != "canceled" || count != 1 || stale.SearchedContexts != 1 {
		t.Fatalf("continued after document revision changed: %+v, batches=%d", stale, count)
	}
}
