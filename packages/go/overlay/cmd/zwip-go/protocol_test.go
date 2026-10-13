package main

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJSONLWorkerLifecycle(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\nfunc Target() {}\nfunc Caller() { Target() }\n")
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { err := serve(inReader, outWriter); outWriter.Close(); done <- err }()
	defer inWriter.Close()
	defer outReader.Close()
	encoder, decoder := json.NewEncoder(inWriter), json.NewDecoder(outReader)
	var progress []navigationBatch
	exchange := func(id int, method string, params any) json.RawMessage {
		t.Helper()
		if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var response struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      int             `json:"id"`
			Result  json.RawMessage `json:"result"`
			Error   *rpcError       `json:"error"`
			Method  string          `json:"method"`
			Params  navigationBatch `json:"params"`
		}
		for {
			if err := decoder.Decode(&response); err != nil {
				t.Fatal(err)
			}
			if response.Method != "navigation.progress" {
				break
			}
			progress = append(progress, response.Params)
			response.Method = ""
		}
		if response.ID != id || response.JSONRPC != "2.0" || response.Error != nil {
			t.Fatalf("bad response: %+v", response)
		}
		return response.Result
	}
	exchange(1, "initialize", initializeParams{Root: root, Generation: 1, Contexts: []buildContext{{ID: "app", Root: filepath.Join(root, "app"), Language: "go"}}})
	deadline := time.Now().Add(30 * time.Second)
	for {
		var status workspaceStatus
		if err := json.Unmarshal(exchange(9, "workspace.status", nil), &status); err != nil {
			t.Fatal(err)
		}
		if status.Contexts[0].State != "loading" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background context did not initialize")
		}
		time.Sleep(10 * time.Millisecond)
	}
	q := navigationQuery{ID: "definition", Operation: "definition", Path: source, Position: position{Line: 2, Character: 17}, WorkspaceGeneration: 1}
	var result navigationBatch
	if err := json.Unmarshal(exchange(2, "navigation.query", q), &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Range.Start.Line != 1 {
		t.Fatalf("definition: %+v", result)
	}
	if len(progress) != 1 || progress[0].State != "loading" || progress[0].ID != q.ID || progress[0].SearchedContexts != 1 || len(progress[0].Locations) != 1 {
		t.Fatalf("missing progress before final response: %+v", progress)
	}
	exchange(3, "document.update", documentUpdate{Path: source, Content: "package app\nfunc Target() {}\nfunc Caller() { /*🧭*/ Target() }\n", Revision: 1})
	q.DocumentRevision = 1
	q.Position.Character = 24
	if err := json.Unmarshal(exchange(4, "navigation.query", q), &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "complete" || len(result.Locations) != 1 || result.Locations[0].Range.Start.Line != 1 {
		t.Fatalf("UTF-16 overlay definition: %+v", result)
	}
	var editorResponse editorResult
	if err := json.Unmarshal(exchange(5, "editor.request", editorQuery{ID: "hover", Operation: "hover", Path: source, Position: &position{Line: 1, Character: 6}, DocumentRevision: 1, WorkspaceGeneration: 1}), &editorResponse); err != nil {
		t.Fatal(err)
	}
	if editorResponse.State != "complete" || !strings.Contains(editorResponse.Hover, "Target") {
		t.Fatalf("editor JSONL: %+v", editorResponse)
	}
	exchange(6, "workspace.changed", map[string]any{"paths": []string{source}})
	var toolResponse toolResult
	if err := json.Unmarshal(exchange(7, "tool.request", map[string]any{"method": "test.start", "params": map[string]any{"path": source}}), &toolResponse); err != nil {
		t.Fatal(err)
	}
	if toolResponse.State != "failed" || len(toolResponse.Reasons) == 0 || !strings.Contains(toolResponse.Reasons[0], "save changes") {
		t.Fatalf("unsaved tool JSONL: %+v", toolResponse)
	}
	exchange(8, "shutdown", nil)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestStaticCallAndTypeNavigation(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package app\ntype Thing struct{}\nvar value Thing\nfunc Target() {}\nfunc Caller() { Target() }\n")
	w := startFixture(t, root, "app")
	cases := []struct {
		operation       string
		line, character uint32
		name            string
	}{
		{"typeDefinition", 2, 6, "Thing"},
		{"incomingCalls", 3, 7, "Caller"},
		{"outgoingCalls", 4, 6, "Target"},
	}
	for _, test := range cases {
		result := w.query(context.Background(), navigationQuery{ID: test.operation, Operation: test.operation, Path: source, Position: position{Line: test.line, Character: test.character}, WorkspaceGeneration: 1})
		if result.State != "complete" || len(result.Locations) != 1 || !strings.Contains(result.Locations[0].Name, test.name) {
			t.Errorf("%s: %+v", test.operation, result)
		}
	}
}

func TestMalformedJSONDoesNotPolluteProtocol(t *testing.T) {
	var output strings.Builder
	if err := serve(strings.NewReader("not json\n"), &output); err != nil {
		t.Fatal(err)
	}
	var response rpcResponse
	if err := json.Unmarshal([]byte(output.String()), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error == nil || response.Error.Code != -32700 {
		t.Fatalf("%+v", response)
	}
}
