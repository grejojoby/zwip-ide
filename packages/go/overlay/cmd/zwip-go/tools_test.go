package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func toolCall(t *testing.T, w *worker, method string, params any) toolResult {
	t.Helper()
	data, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return w.tool(context.Background(), toolQuery{Method: method, Params: data})
}

func TestToolGoTestsSubtestsAndCoverage(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	source := put(t, root, "app/calc.go", "package app\nfunc Double(n int) int { if n < 0 { return 0 }; return n*2 }\n")
	put(t, root, "app/calc_test.go", `package app
import "testing"
func TestDouble(t *testing.T) { t.Run("positive",func(t *testing.T){ if Double(2)!=4 {t.Fatal("bad")}}) }
`)
	w := startFixture(t, root, "app")
	result := toolCall(t, w, "test.start", map[string]any{"path": source, "coverage": true})
	if result.State != "complete" || result.Job == nil {
		t.Fatalf("%+v", result)
	}
	deadline := time.Now().Add(45 * time.Second)
	for result.Job.Status == "running" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		result = toolCall(t, w, "job.poll", map[string]any{"jobId": result.Job.ID})
	}
	if result.Job.Status != "completed" || result.Job.Coverage == nil {
		t.Fatalf("%+v", result)
	}
	found := false
	for _, event := range result.Job.Events {
		if event.Test != nil && event.Test["Test"] == "TestDouble/positive" && event.Test["Action"] == "pass" {
			found = true
		}
	}
	if !found {
		t.Fatalf("subtest not reported: %+v", result.Job.Events)
	}
	coverage := result.Job.Coverage
	if len(coverage.Files) != 1 || coverage.Percent <= 0 || coverage.Percent >= 100 || len(coverage.Files[0].Blocks) == 0 {
		t.Fatalf("%+v", coverage)
	}
	if coverage.Files[0].Path != source {
		t.Fatalf("coverage path: %+v", coverage.Files[0])
	}
	if result = toolCall(t, w, "run.start", map[string]any{"contextId": "app", "package": "../../escape"}); result.State != "failed" {
		t.Fatalf("escape accepted: %+v", result)
	}
}

func TestToolRunOutputAndCancellation(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	put(t, root, "app/main.go", "package main\nimport (\"fmt\";\"os\";\"time\")\nfunc main(){fmt.Println(os.Args[1]); time.Sleep(time.Minute)}\n")
	w := startFixture(t, root, "app")
	result := toolCall(t, w, "run.start", map[string]any{"contextId": "app", "programArgs": []string{"literal $(not a shell)"}})
	if result.Job == nil {
		t.Fatalf("%+v", result)
	}
	id := result.Job.ID
	deadline := time.Now().Add(30 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		result = toolCall(t, w, "job.poll", map[string]any{"jobId": id})
		for _, event := range result.Job.Events {
			if strings.Contains(event.Text, "literal $(not a shell)") {
				found = true
			}
		}
		if found {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		t.Fatalf("output missing: %+v", result.Job)
	}
	toolCall(t, w, "job.cancel", map[string]any{"jobId": id})
	for i := 0; i < 100; i++ {
		result = toolCall(t, w, "job.poll", map[string]any{"jobId": id})
		if result.Job.Status != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.Job.Status != "canceled" {
		t.Fatalf("%+v", result.Job)
	}
	w.close()
	if result = toolCall(t, w, "job.poll", map[string]any{"jobId": id}); result.State != "failed" {
		t.Fatalf("job retained after close: %+v", result)
	}
}
