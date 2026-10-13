package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type toolQuery struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type toolResult struct {
	State         string       `json:"state"`
	Reasons       []string     `json:"reasons"`
	Job           *jobSnapshot `json:"job,omitempty"`
	SessionID     string       `json:"sessionId,omitempty"`
	Capabilities  any          `json:"capabilities,omitempty"`
	Response      any          `json:"response,omitempty"`
	Events        []debugEvent `json:"events,omitempty"`
	Cursor        int64        `json:"cursor,omitempty"`
	Status        string       `json:"status,omitempty"`
	DroppedBefore int64        `json:"droppedBefore,omitempty"`
}
type toolService struct {
	mu        sync.Mutex
	next      int64
	jobs      map[string]*goJob
	debuggers map[string]*debugSession
}

func newToolService() *toolService {
	return &toolService{jobs: map[string]*goJob{}, debuggers: map[string]*debugSession{}}
}

// Completed results are retained for polling, with a bounded session history.
// Active processes are never evicted by this bookkeeping.
func (s *toolService) prune() {
	if len(s.jobs) >= 32 {
		for id, job := range s.jobs {
			job.mu.Lock()
			completed := job.status != "running"
			job.mu.Unlock()
			if completed {
				delete(s.jobs, id)
			}
			if len(s.jobs) < 32 {
				break
			}
		}
	}
	if len(s.debuggers) >= 16 {
		for id, session := range s.debuggers {
			session.mu.Lock()
			stopped := session.status == "stopped"
			session.mu.Unlock()
			if stopped {
				delete(s.debuggers, id)
			}
			if len(s.debuggers) < 16 {
				break
			}
		}
	}
}
func toolOK() toolResult { return toolResult{State: "complete", Reasons: []string{}} }
func toolFailure(err error) toolResult {
	return toolResult{State: "failed", Reasons: []string{err.Error()}}
}

func (w *worker) tool(ctx context.Context, q toolQuery) toolResult {
	if err := ctx.Err(); err != nil {
		return toolFailure(err)
	}
	switch q.Method {
	case "run.start", "test.start":
		var p jobStart
		if err := json.Unmarshal(q.Params, &p); err != nil {
			return toolFailure(err)
		}
		return w.startJob(ctx, q.Method, p)
	case "job.poll", "job.cancel":
		var p struct {
			JobID string `json:"jobId"`
			After int64  `json:"after"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil {
			return toolFailure(err)
		}
		w.tools.mu.Lock()
		job := w.tools.jobs[p.JobID]
		w.tools.mu.Unlock()
		if job == nil {
			return toolFailure(fmt.Errorf("unknown job"))
		}
		if q.Method == "job.cancel" {
			job.cancel()
		}
		result := toolOK()
		result.Job = job.snapshot(p.After)
		return result
	case "debug.start", "debug.request", "debug.poll", "debug.stop":
		return w.debugTool(ctx, q)
	default:
		return toolResult{State: "unsupported", Reasons: []string{"unsupported Go tool method: " + q.Method}}
	}
}

func (w *worker) stopTools() {
	w.tools.mu.Lock()
	jobs, debuggers := w.tools.jobs, w.tools.debuggers
	w.tools.jobs = map[string]*goJob{}
	w.tools.debuggers = map[string]*debugSession{}
	w.tools.mu.Unlock()
	for _, job := range jobs {
		job.cancel()
	}
	var stopped sync.WaitGroup
	for _, session := range debuggers {
		stopped.Add(1)
		go func() { defer stopped.Done(); session.stop() }()
	}
	for _, job := range jobs {
		<-job.done
	}
	stopped.Wait()
}

func (w *worker) toolContext(contextID, path string) (buildContext, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session == nil {
		return buildContext{}, fmt.Errorf("provider is not initialized")
	}
	var err error
	if path != "" {
		path, err = canonical(path)
		if err != nil {
			return buildContext{}, err
		}
	}
	var selected *buildContext
	for i := range w.contexts {
		c := &w.contexts[i]
		if contextID != "" {
			if c.ID == contextID {
				selected = c
				break
			}
		} else if c.ProfileID == "" && path != "" && within(c.Root, path) && (selected == nil || len(c.Root) > len(selected.Root)) {
			selected = c
		}
	}
	if selected == nil {
		return buildContext{}, fmt.Errorf("an included Go contextId or source path is required")
	}
	if selected.State != "ready" {
		w.prioritizeContextIDLocked(selected.ID)
		return buildContext{}, fmt.Errorf("context %s is %s: %s", selected.ID, selected.State, selected.Reason)
	}
	if path != "" && !within(selected.Root, path) {
		return buildContext{}, fmt.Errorf("source path is outside context")
	}
	view := w.views[selected.ID]
	if view == nil {
		return buildContext{}, fmt.Errorf("context view is unavailable")
	}
	if err := nativeTarget(view.GOOS(), view.GOARCH()); err != nil {
		return buildContext{}, err
	}
	// Tools operate on saved source. Never silently execute a different version
	// from the editor's visible unsaved program.
	for file, doc := range w.documents {
		// Other included modules may be local replacements used by this one.
		if within(w.root, file) {
			disk, err := os.ReadFile(file)
			if err != nil || string(disk) != doc.Content {
				return buildContext{}, fmt.Errorf("save changes before running Go tools: %s", file)
			}
		}
	}
	result := *selected
	// Pin execution to the target already analyzed, including defaults obtained
	// from Go's environment file. Debug launch overrides cannot change it.
	result.profile.GOOS, result.profile.GOARCH = view.GOOS(), view.GOARCH()
	return result, nil
}

func configuredGo() string {
	if value := os.Getenv("ZWIP_GO"); value != "" {
		return value
	}
	return defaultGo
}
func toolEnvironment(c buildContext) []string {
	env := os.Environ()
	for key, value := range profileEnvironment(c) {
		env = append(env, key+"="+value)
	}
	return append(env, "GOWORK="+contextGoWork(c), "GOTOOLCHAIN=local", "GOROOT="+filepath.Dir(filepath.Dir(configuredGo())), "PATH="+filepath.Dir(configuredGo())+string(os.PathListSeparator)+os.Getenv("PATH"))
}
func packageArgument(c buildContext, p jobStart) (string, error) {
	if p.Path != "" {
		path, err := canonical(p.Path)
		if err != nil {
			return "", err
		}
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			if filepath.Ext(path) != ".go" {
				return "", fmt.Errorf("expected a Go source file")
			}
			path = filepath.Dir(path)
		}
		if !within(c.Root, path) {
			return "", fmt.Errorf("package escapes context")
		}
		rel, _ := filepath.Rel(c.Root, path)
		if rel == "." {
			return ".", nil
		}
		return "./" + filepath.ToSlash(rel), nil
	}
	value := p.Package
	if value == "" {
		value = "."
	}
	if value == "./..." {
		return value, nil
	}
	if strings.HasPrefix(value, "-") || strings.Contains(value, "...") || filepath.IsAbs(value) {
		return "", fmt.Errorf("package must be relative to the selected module")
	}
	target, err := canonical(filepath.Join(c.Root, value))
	if err != nil {
		return "", err
	}
	if !within(c.Root, target) {
		return "", fmt.Errorf("package escapes context")
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("package must be a directory")
	}
	rel, _ := filepath.Rel(c.Root, target)
	if rel == "." {
		return ".", nil
	}
	return "./" + filepath.ToSlash(rel), nil
}
