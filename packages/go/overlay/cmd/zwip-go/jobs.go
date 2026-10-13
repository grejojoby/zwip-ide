package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
)

type jobStart struct {
	ContextID   string   `json:"contextId"`
	Path        string   `json:"path"`
	Package     string   `json:"package"`
	ProgramArgs []string `json:"programArgs"`
	TestPattern string   `json:"testPattern"`
	Coverage    bool     `json:"coverage"`
}
type jobEvent struct {
	Sequence int64          `json:"sequence"`
	Kind     string         `json:"kind"`
	Stream   string         `json:"stream,omitempty"`
	Text     string         `json:"text,omitempty"`
	Test     map[string]any `json:"test,omitempty"`
}
type jobSnapshot struct {
	ID            string           `json:"id"`
	Status        string           `json:"status"`
	Cursor        int64            `json:"cursor"`
	Events        []jobEvent       `json:"events"`
	DroppedBefore int64            `json:"droppedBefore,omitempty"`
	ExitCode      *int             `json:"exitCode,omitempty"`
	Coverage      *coverageSummary `json:"coverage,omitempty"`
	Reasons       []string         `json:"reasons"`
}
type goJob struct {
	mu         sync.Mutex
	id, status string
	cursor     int64
	events     []jobEvent
	eventBytes int
	exitCode   *int
	coverage   *coverageSummary
	reasons    []string
	cancel     context.CancelFunc
	done       chan struct{}
}

func (j *goJob) add(event jobEvent) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cursor++
	event.Sequence = j.cursor
	j.events = append(j.events, event)
	j.eventBytes += len(event.Text) * 2 // Test JSON also retains the decoded output.
	for len(j.events) > 1 && (len(j.events) > 2000 || j.eventBytes > 2*1024*1024) {
		j.eventBytes -= len(j.events[0].Text) * 2
		j.events[0] = jobEvent{}
		j.events = j.events[1:]
	}
}
func (j *goJob) snapshot(after int64) *jobSnapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	r := &jobSnapshot{ID: j.id, Status: j.status, Cursor: j.cursor, ExitCode: j.exitCode, Coverage: j.coverage, Events: []jobEvent{}, Reasons: append([]string{}, j.reasons...)}
	if len(j.events) > 0 && j.events[0].Sequence > 1 {
		r.DroppedBefore = j.events[0].Sequence
	}
	for _, event := range j.events {
		if event.Sequence > after {
			r.Events = append(r.Events, event)
		}
	}
	return r
}

func processCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	return cmd
}

func (w *worker) startJob(ctx context.Context, method string, p jobStart) toolResult {
	epoch := w.epoch.Load()
	c, err := w.toolContext(p.ContextID, p.Path)
	if err != nil {
		return toolFailure(err)
	}
	target, err := packageArgument(c, p)
	if err != nil {
		return toolFailure(err)
	}
	if method == "run.start" && target == "./..." {
		return toolFailure(fmt.Errorf("run requires one main package"))
	}
	temp, err := os.MkdirTemp("", "zwip-go-job-")
	if err != nil {
		return toolFailure(err)
	}
	args := []string{"run"}
	if method == "test.start" {
		args = []string{"test", "-json", "-count=1"}
	}
	args = append(args, contextBuildFlags(c)...)
	profile := ""
	if method == "test.start" {
		if p.TestPattern != "" {
			args = append(args, "-run", p.TestPattern)
		}
		if p.Coverage {
			profile = filepath.Join(temp, "coverage.out")
			args = append(args, "-coverprofile="+profile)
		}
	}
	args = append(args, target)
	if method == "run.start" {
		args = append(args, p.ProgramArgs...)
	} else if len(p.ProgramArgs) > 0 {
		args = append(args, "-args")
		args = append(args, p.ProgramArgs...)
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	cmd := processCommand(jobCtx, configuredGo(), args...)
	cmd.Dir = c.Root
	cmd.Env = toolEnvironment(c)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		os.RemoveAll(temp)
		return toolFailure(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		os.RemoveAll(temp)
		return toolFailure(err)
	}
	// Hold the registry lock through process creation so shutdown cannot miss it.
	w.tools.mu.Lock()
	if epoch != w.epoch.Load() {
		w.tools.mu.Unlock()
		cancel()
		os.RemoveAll(temp)
		return toolFailure(fmt.Errorf("workspace changed"))
	}
	if err = ctx.Err(); err == nil {
		err = cmd.Start()
	}
	if err != nil {
		w.tools.mu.Unlock()
		cancel()
		os.RemoveAll(temp)
		return toolFailure(err)
	}
	w.tools.next++
	w.tools.prune()
	id := fmt.Sprintf("go-job-%d", w.tools.next)
	job := &goJob{id: id, status: "running", cancel: cancel, done: make(chan struct{})}
	w.tools.jobs[id] = job
	w.tools.mu.Unlock()
	go func() {
		defer close(job.done)
		defer cancel()
		defer os.RemoveAll(temp)
		var readers sync.WaitGroup
		scan := func(reader io.Reader, stream string) {
			defer readers.Done()
			scanner := bufio.NewScanner(reader)
			scanner.Buffer(make([]byte, 4096), 128*1024)
			for scanner.Scan() {
				line := scanner.Text()
				event := jobEvent{Kind: "output", Stream: stream, Text: line + "\n"}
				if method == "test.start" && stream == "stdout" {
					var test map[string]any
					if json.Unmarshal(scanner.Bytes(), &test) == nil && test["Action"] != nil {
						event.Kind = "test"
						event.Test = test
					}
				}
				job.add(event)
			}
			if err := scanner.Err(); err != nil {
				job.add(jobEvent{Kind: "output", Stream: "stderr", Text: "Output read failed: " + err.Error()})
				// Drain an overlong output line so the child cannot deadlock on
				// a full pipe after the bounded scanner stops.
				_, _ = io.Copy(io.Discard, reader)
			}
		}
		readers.Add(2)
		go scan(stdout, "stdout")
		go scan(stderr, "stderr")
		readers.Wait()
		waitErr := cmd.Wait()
		code := cmd.ProcessState.ExitCode()
		var summary *coverageSummary
		var coverageErr error
		if profile != "" {
			summary, coverageErr = readCoverage(profile, c)
			if w.epoch.Load() != epoch {
				summary, coverageErr = nil, fmt.Errorf("workspace changed while tests were running")
			}
		}
		job.mu.Lock()
		defer job.mu.Unlock()
		job.exitCode = &code
		job.coverage = summary
		job.status = "completed"
		if waitErr != nil {
			job.status = "failed"
			job.reasons = append(job.reasons, waitErr.Error())
		}
		if jobCtx.Err() != nil {
			job.status = "canceled"
		}
		if coverageErr != nil {
			job.reasons = append(job.reasons, "Coverage unavailable: "+coverageErr.Error())
		}
	}()
	result := toolOK()
	result.Job = job.snapshot(0)
	return result
}
