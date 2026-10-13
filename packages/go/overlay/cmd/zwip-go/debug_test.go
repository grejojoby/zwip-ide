package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDAPFraming(t *testing.T) {
	body := `{"seq":3,"type":"event","event":"stopped","body":{"reason":"breakpoint"}}`
	message, err := readDAP(bufio.NewReader(strings.NewReader(fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body))))
	if err != nil || message.Event != "stopped" {
		t.Fatalf("%+v %v", message, err)
	}
	for _, bad := range []string{"\r\n", "Content-Length: -1\r\n\r\n", "Content-Length: 9999999999\r\n\r\n", "wrong\r\n\r\n"} {
		if _, err := readDAP(bufio.NewReader(strings.NewReader(bad))); err == nil {
			t.Fatalf("accepted malformed frame %q", bad)
		}
	}
}

func waitDebugEvent(t *testing.T, w *worker, id, name string, after int64) debugEvent {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	var last toolResult
	for time.Now().Before(deadline) {
		last = toolCall(t, w, "debug.poll", map[string]any{"sessionId": id, "after": after})
		for _, event := range last.Events {
			if event.Event == name {
				return event
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("missing %s event: %+v", name, last)
	return debugEvent{}
}
func dapBody(t *testing.T, result toolResult) map[string]any {
	t.Helper()
	if result.State != "complete" {
		t.Fatalf("DAP failed: %+v", result)
	}
	response, ok := result.Response.(dapMessage)
	if !ok {
		t.Fatalf("no DAP response: %+v", result)
	}
	var body map[string]any
	if len(response.Body) == 0 {
		return map[string]any{}
	}
	if err := json.Unmarshal(response.Body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}
func TestDelveBreakpointStackVariablesContinue(t *testing.T) {
	if os.Getenv("ZWIP_DLV") == "" {
		t.Skip("run node packages/go/build.mjs debug-test for the real Delve integration")
	}
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package main\nimport (\"fmt\"; \"time\")\nfunc main() {\n value := 42\n fmt.Println(value)\n value++\n time.Sleep(2*time.Second)\n fmt.Println(value)\n}\n")
	w := startFixture(t, root, "app")
	started := toolCall(t, w, "debug.start", map[string]any{"path": source})
	if started.State != "complete" || started.SessionID == "" {
		t.Fatalf("start: %+v", started)
	}
	id := started.SessionID
	launch := make(chan toolResult, 1)
	launchParams, _ := json.Marshal(map[string]any{"sessionId": id, "command": "launch", "arguments": map[string]any{"program": source, "mode": "debug"}})
	go func() {
		result := w.tool(context.Background(), toolQuery{Method: "debug.request", Params: launchParams})
		launch <- result
	}()
	waitDebugEvent(t, w, id, "initialized", 0)
	breakpoints := dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "setBreakpoints", "arguments": map[string]any{"source": map[string]any{"path": source}, "breakpoints": []any{map[string]any{"line": 5}}}}))
	points := breakpoints["breakpoints"].([]any)
	if len(points) != 1 || points[0].(map[string]any)["verified"] != true {
		t.Fatalf("breakpoints: %+v", breakpoints)
	}
	if result := toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "configurationDone", "arguments": map[string]any{}}); result.State != "complete" {
		t.Fatalf("configuration: %+v", result)
	}
	select {
	case result := <-launch:
		if result.State != "complete" {
			t.Fatalf("launch: %+v", result)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("launch timed out")
	}
	stopped := waitDebugEvent(t, w, id, "stopped", 0)
	thread := stopped.Body.(map[string]any)["threadId"]
	stack := dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "stackTrace", "arguments": map[string]any{"threadId": thread}}))
	frames := stack["stackFrames"].([]any)
	if len(frames) == 0 {
		t.Fatal("no stack")
	}
	frame := frames[0].(map[string]any)
	if frame["line"] != float64(5) {
		t.Fatalf("wrong frame: %+v", frame)
	}
	scopes := dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "scopes", "arguments": map[string]any{"frameId": frame["id"]}}))
	found := false
	for _, raw := range scopes["scopes"].([]any) {
		scope := raw.(map[string]any)
		variables := dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "variables", "arguments": map[string]any{"variablesReference": scope["variablesReference"]}}))
		for _, raw := range variables["variables"].([]any) {
			variable := raw.(map[string]any)
			if variable["name"] == "value" && variable["value"] == "42" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("local value = 42 was not visible")
	}
	watch := dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "evaluate", "arguments": map[string]any{"expression": "value + 1", "frameId": frame["id"], "context": "watch"}}))
	if watch["result"] != "43" {
		t.Fatalf("watch expression: %+v", watch)
	}
	for _, line := range []float64{6, 7} {
		dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "next", "arguments": map[string]any{"threadId": thread}}))
		stopped = waitDebugEvent(t, w, id, "stopped", stopped.Sequence)
		stack = dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "stackTrace", "arguments": map[string]any{"threadId": thread}}))
		frame = stack["stackFrames"].([]any)[0].(map[string]any)
		if frame["line"] != line {
			t.Fatalf("step expected line %.0f: %+v", line, frame)
		}
	}
	watch = dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "evaluate", "arguments": map[string]any{"expression": "value", "frameId": frame["id"], "context": "watch"}}))
	if watch["result"] != "43" {
		t.Fatalf("watch after step: %+v", watch)
	}
	dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "continue", "arguments": map[string]any{"threadId": thread}}))
	time.Sleep(50 * time.Millisecond)
	dapBody(t, toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "pause", "arguments": map[string]any{"threadId": thread}}))
	stopped = waitDebugEvent(t, w, id, "stopped", stopped.Sequence)
	if stopped.Body.(map[string]any)["reason"] != "pause" {
		t.Fatalf("pause: %+v", stopped)
	}
	if result := toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "continue", "arguments": map[string]any{"threadId": thread}}); result.State != "complete" {
		t.Fatalf("continue: %+v", result)
	}
	waitDebugEvent(t, w, id, "terminated", stopped.Sequence)
	if result := toolCall(t, w, "debug.stop", map[string]any{"sessionId": id}); result.Status != "stopped" {
		t.Fatalf("stop: %+v", result)
	}
	w.tools.mu.Lock()
	session := w.tools.debuggers[id]
	w.tools.mu.Unlock()
	select {
	case <-session.processDone:
	case <-time.After(2 * time.Second):
		t.Fatal("adapter process survived debug.stop")
	}
}

// This verifies the real adapter/transport lifecycle even on hosts where
// macOS task_for_pid authorization blocks the separate breakpoint proof.
func TestDelveNoDebugLaunchAndOutput(t *testing.T) {
	if os.Getenv("ZWIP_DLV") == "" {
		t.Skip("run debug-test for Delve integration")
	}
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/main.go", "package main\nimport \"fmt\"\nfunc main(){fmt.Println(message())}\n")
	put(t, root, "app/message.go", "package main\nfunc message() string { return \"adapter-output\" }\n")
	w := startFixture(t, root, "app")
	started := toolCall(t, w, "debug.start", map[string]any{"path": source})
	if started.State != "complete" {
		t.Fatalf("%+v", started)
	}
	id := started.SessionID
	result := toolCall(t, w, "debug.request", map[string]any{"sessionId": id, "command": "launch", "arguments": map[string]any{"program": source, "noDebug": true}})
	if result.State != "complete" {
		t.Fatalf("%+v", result)
	}
	waitDebugEvent(t, w, id, "terminated", 0)
	result = toolCall(t, w, "debug.poll", map[string]any{"sessionId": id})
	found := false
	for _, event := range result.Events {
		if event.Event == "output" {
			body, _ := event.Body.(map[string]any)
			output, _ := body["output"].(string)
			if strings.Contains(output, "adapter-output") {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("missing program output: %+v", result.Events)
	}
	if result = toolCall(t, w, "debug.stop", map[string]any{"sessionId": id}); result.Status != "stopped" {
		t.Fatalf("%+v", result)
	}
}
