package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type debugEvent struct {
	Sequence int64  `json:"sequence"`
	Event    string `json:"event"`
	Body     any    `json:"body,omitempty"`
	bytes    int
}
type dapMessage struct {
	Seq        int64           `json:"seq"`
	Type       string          `json:"type"`
	RequestSeq int64           `json:"request_seq,omitempty"`
	Success    bool            `json:"success,omitempty"`
	Command    string          `json:"command,omitempty"`
	Event      string          `json:"event,omitempty"`
	Message    string          `json:"message,omitempty"`
	Body       json.RawMessage `json:"body,omitempty"`
	Arguments  any             `json:"arguments,omitempty"`
}
type debugSession struct {
	mu             sync.Mutex
	writeMu        sync.Mutex
	stopOnce       sync.Once
	id             string
	context        buildContext
	dir            string
	conn           net.Conn
	next, cursor   int64
	pending        map[int64]chan dapMessage
	events         []debugEvent
	eventBytes     int
	cancel         context.CancelFunc
	processDone    chan struct{}
	connectionDone chan struct{}
	status         string
	stopping       bool
}

func (s *debugSession) event(name string, body any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cursor++
	encoded, _ := json.Marshal(body)
	s.events = append(s.events, debugEvent{Sequence: s.cursor, Event: name, Body: body, bytes: len(encoded)})
	s.eventBytes += len(encoded)
	for len(s.events) > 1 && (len(s.events) > 2000 || s.eventBytes > 2*1024*1024) {
		s.eventBytes -= s.events[0].bytes
		s.events[0] = debugEvent{}
		s.events = s.events[1:]
	}
}

type debugOutput struct {
	s        *debugSession
	category string
}

func (o debugOutput) Write(data []byte) (int, error) {
	n := len(data)
	for len(data) > 0 {
		end := min(len(data), 16*1024)
		o.s.event("output", map[string]any{"category": o.category, "output": string(data[:end])})
		data = data[end:]
	}
	return n, nil
}

func readDAP(reader *bufio.Reader) (dapMessage, error) {
	length := -1
	headerBytes := 0
	for {
		lineBytes, err := reader.ReadSlice('\n')
		if err != nil {
			return dapMessage{}, err
		}
		headerBytes += len(lineBytes)
		if headerBytes > 8192 {
			return dapMessage{}, fmt.Errorf("DAP header too large")
		}
		line := strings.TrimSpace(string(lineBytes))
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return dapMessage{}, fmt.Errorf("malformed DAP header")
		}
		if strings.EqualFold(key, "Content-Length") {
			length, err = strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return dapMessage{}, err
			}
		}
	}
	if length < 0 || length > 32*1024*1024 {
		return dapMessage{}, fmt.Errorf("invalid DAP Content-Length")
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(reader, data); err != nil {
		return dapMessage{}, err
	}
	var message dapMessage
	err := json.Unmarshal(data, &message)
	return message, err
}
func (s *debugSession) read() {
	defer close(s.connectionDone)
	reader := bufio.NewReader(s.conn)
	for {
		message, err := readDAP(reader)
		if err != nil {
			if err != io.EOF {
				s.event("transportError", map[string]string{"message": err.Error()})
			}
			return
		}
		switch message.Type {
		case "response":
			s.mu.Lock()
			pending := s.pending[message.RequestSeq]
			delete(s.pending, message.RequestSeq)
			s.mu.Unlock()
			if pending != nil {
				pending <- message
			}
		case "event":
			var body any
			_ = json.Unmarshal(message.Body, &body)
			s.event(message.Event, body)
		case "request":
			s.event("unsupportedReverseRequest", map[string]string{"command": message.Command})
		}
	}
}
func (s *debugSession) request(ctx context.Context, command string, args any) (dapMessage, error) {
	s.mu.Lock()
	s.next++
	seq := s.next
	response := make(chan dapMessage, 1)
	s.pending[seq] = response
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, seq); s.mu.Unlock() }()
	data, err := json.Marshal(dapMessage{Seq: seq, Type: "request", Command: command, Arguments: args})
	if err != nil {
		return dapMessage{}, err
	}
	s.writeMu.Lock()
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = s.conn.SetWriteDeadline(deadline)
	_, err = fmt.Fprintf(s.conn, "Content-Length: %d\r\n\r\n%s", len(data), data)
	_ = s.conn.SetWriteDeadline(time.Time{})
	s.writeMu.Unlock()
	if err != nil {
		return dapMessage{}, err
	}
	select {
	case message := <-response:
		if !message.Success {
			return message, fmt.Errorf("%s: %s", command, message.Message)
		}
		return message, nil
	case <-ctx.Done():
		return dapMessage{}, ctx.Err()
	case <-s.connectionDone:
		return dapMessage{}, fmt.Errorf("debug adapter disconnected")
	}
}
func (s *debugSession) stop() {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.stopping = true
		conn := s.conn
		s.mu.Unlock()
		if conn != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			_, _ = s.request(ctx, "disconnect", map[string]any{"terminateDebuggee": true})
			cancel()
			_ = conn.Close()
		}
		s.cancel()
		<-s.processDone
		_ = os.RemoveAll(s.dir)
		s.mu.Lock()
		s.status = "stopped"
		s.mu.Unlock()
	})
}

func (w *worker) debugTool(ctx context.Context, q toolQuery) toolResult {
	if q.Method == "debug.start" {
		var p struct {
			ContextID string `json:"contextId"`
			Path      string `json:"path"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil {
			return toolFailure(err)
		}
		return w.startDebug(ctx, p.ContextID, p.Path)
	}
	var p struct {
		SessionID string         `json:"sessionId"`
		Command   string         `json:"command"`
		Arguments map[string]any `json:"arguments"`
		After     int64          `json:"after"`
	}
	if err := json.Unmarshal(q.Params, &p); err != nil {
		return toolFailure(err)
	}
	w.tools.mu.Lock()
	s := w.tools.debuggers[p.SessionID]
	w.tools.mu.Unlock()
	if s == nil {
		return toolFailure(fmt.Errorf("unknown debug session"))
	}
	result := toolOK()
	result.SessionID = s.id
	switch q.Method {
	case "debug.poll":
		s.mu.Lock()
		defer s.mu.Unlock()
		result.Events = []debugEvent{}
		result.Cursor = s.cursor
		result.Status = s.status
		if len(s.events) > 0 && s.events[0].Sequence > 1 {
			result.DroppedBefore = s.events[0].Sequence
		}
		for _, event := range s.events {
			if event.Sequence > p.After {
				result.Events = append(result.Events, event)
			}
		}
	case "debug.stop":
		s.stop()
		result.Status = "stopped"
	case "debug.request":
		if p.Command == "" || p.Command == "initialize" || p.Command == "attach" {
			return toolFailure(fmt.Errorf("unsupported debug command: %s", p.Command))
		}
		if p.Command == "launch" {
			if _, err := w.toolContext(s.context.ID, ""); err != nil {
				return toolFailure(err)
			}
			args, err := s.launchArguments(p.Arguments)
			if err != nil {
				return toolFailure(err)
			}
			p.Arguments = args
		}
		requestCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		response, err := s.request(requestCtx, p.Command, p.Arguments)
		if err != nil {
			result = toolFailure(err)
			if p.Command == "launch" && requestCtx.Err() != nil {
				result.Reasons = append(result.Reasons, "Delve did not complete launch; inspect adapter output and host debugger authorization. The session has been stopped.")
				s.stop()
			}
		}
		result.Response = response
	}
	return result
}

func (w *worker) startDebug(ctx context.Context, contextID, path string) toolResult {
	epoch := w.epoch.Load()
	c, err := w.toolContext(contextID, path)
	if err != nil {
		return toolFailure(err)
	}
	binary := os.Getenv("ZWIP_DLV")
	if binary == "" {
		exe, err := os.Executable()
		if err != nil {
			return toolFailure(err)
		}
		binary = filepath.Join(filepath.Dir(exe), "dlv")
	}
	if !filepath.IsAbs(binary) {
		return toolFailure(fmt.Errorf("ZWIP_DLV must be absolute"))
	}
	// The adapter connects to a private Unix socket; no TCP debug port is exposed.
	dir, err := os.MkdirTemp("", "zwip-go-debug-")
	if err != nil {
		return toolFailure(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "dap.sock"))
	if err != nil {
		os.RemoveAll(dir)
		return toolFailure(err)
	}
	defer listener.Close()
	processCtx, cancel := context.WithCancel(context.Background())
	s := &debugSession{context: c, dir: dir, pending: map[int64]chan dapMessage{}, cancel: cancel, processDone: make(chan struct{}), connectionDone: make(chan struct{}), status: "starting"}
	args := []string{"dap", "--client-addr=unix:" + filepath.Join(dir, "dap.sock")}
	if os.Getenv("ZWIP_DAP_LOG") == "1" {
		args = append(args, "--log", "--log-output=dap,debugger,gdbwire")
	}
	cmd := processCommand(processCtx, binary, args...)
	cmd.Dir = c.Root
	cmd.Env = toolEnvironment(c)
	cmd.Stdout = debugOutput{s, "stdout"}
	cmd.Stderr = debugOutput{s, "stderr"}
	w.tools.mu.Lock()
	if epoch != w.epoch.Load() {
		w.tools.mu.Unlock()
		cancel()
		os.RemoveAll(dir)
		return toolFailure(fmt.Errorf("workspace changed"))
	}
	if err = cmd.Start(); err != nil {
		w.tools.mu.Unlock()
		cancel()
		os.RemoveAll(dir)
		return toolFailure(err)
	}
	w.tools.next++
	w.tools.prune()
	s.id = fmt.Sprintf("go-debug-%d", w.tools.next)
	w.tools.debuggers[s.id] = s
	w.tools.mu.Unlock()
	go func() {
		err := cmd.Wait()
		s.mu.Lock()
		s.status = "exited"
		s.mu.Unlock()
		if err != nil {
			s.event("adapterExited", map[string]string{"message": err.Error()})
		}
		close(s.processDone)
		listener.Close()
	}()
	_ = listener.(*net.UnixListener).SetDeadline(time.Now().Add(10 * time.Second))
	stopAccept := context.AfterFunc(ctx, func() { listener.Close() })
	defer stopAccept()
	conn, err := listener.Accept()
	if err != nil {
		s.stop()
		return toolFailure(fmt.Errorf("debug adapter failed to connect: %w", err))
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		conn.Close()
		return toolFailure(fmt.Errorf("debug session stopped during startup"))
	}
	s.conn = conn
	go s.read()
	s.mu.Unlock()
	requestCtx, requestCancel := context.WithTimeout(ctx, 10*time.Second)
	defer requestCancel()
	response, err := s.request(requestCtx, "initialize", map[string]any{"clientID": "zwip", "adapterID": "go", "pathFormat": "path", "linesStartAt1": true, "columnsStartAt1": true, "supportsVariableType": true, "supportsVariablePaging": true, "supportsRunInTerminalRequest": false})
	if err != nil {
		s.stop()
		return toolFailure(err)
	}
	s.mu.Lock()
	s.status = "ready"
	s.mu.Unlock()
	result := toolOK()
	result.SessionID = s.id
	result.Capabilities = response.Body
	return result
}

func (s *debugSession) launchArguments(input map[string]any) (map[string]any, error) {
	args := map[string]any{}
	for key, value := range input {
		args[key] = value
	}
	mode, _ := args["mode"].(string)
	if mode == "" {
		mode = "debug"
	}
	if mode != "debug" && mode != "test" {
		return nil, fmt.Errorf("debug launch supports debug or test mode")
	}
	program, _ := args["program"].(string)
	if program == "" {
		program = s.context.Root
	}
	if !filepath.IsAbs(program) {
		program = filepath.Join(s.context.Root, program)
	}
	program, err := canonical(program)
	if err != nil {
		return nil, err
	}
	if !within(s.context.Root, program) {
		return nil, fmt.Errorf("debug program escapes selected module")
	}
	info, err := os.Stat(program)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		if filepath.Ext(program) != ".go" {
			return nil, fmt.Errorf("debug program must be a package directory or Go source file")
		}
		program = filepath.Dir(program)
	}
	cwd := s.context.Root
	if supplied, present := args["cwd"]; present {
		requested, ok := supplied.(string)
		if !ok || !filepath.IsAbs(requested) {
			return nil, fmt.Errorf("debug working directory must be an absolute directory inside the selected module")
		}
		cwd, err = canonical(requested)
		if err != nil {
			return nil, err
		}
		if !within(s.context.Root, cwd) {
			return nil, fmt.Errorf("debug working directory escapes selected module")
		}
		info, err := os.Stat(cwd)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("debug working directory must be a directory")
		}
	}
	env := map[string]any{}
	if custom, ok := args["env"].(map[string]any); ok {
		for key, value := range custom {
			if !debugBuildEnvironmentKey(key) {
				env[key] = value
			}
		}
	}
	for _, key := range []string{"GOWORK", "GOTOOLCHAIN", "GOROOT", "PATH", "GOOS", "GOARCH", "CGO_ENABLED"} {
		for _, entry := range toolEnvironment(s.context) {
			if strings.HasPrefix(entry, key+"=") {
				env[key] = strings.TrimPrefix(entry, key+"=")
			}
		}
	}
	args["mode"] = mode
	args["program"] = program
	args["cwd"] = cwd
	args["dlvCwd"] = s.context.Root
	args["env"] = env
	// Delve accepts argv arrays. Preserve spaces in private overlay paths.
	args["buildFlags"] = contextBuildFlags(s.context)
	args["output"] = filepath.Join(s.dir, "debuggee")
	args["console"] = "internalConsole"
	return args, nil
}

// Launch env configures the program, not a second implicit build profile.
// Inherit these SDK/build variables from the adapter's selected context and
// apply its explicit settings below; callers may still set application vars.
func debugBuildEnvironmentKey(key string) bool {
	if strings.HasPrefix(key, "CGO_") {
		return true
	}
	switch key {
	case "GOWORK", "GOTOOLCHAIN", "GOROOT", "PATH", "GOOS", "GOARCH", "GOFLAGS", "GOENV", "GO111MODULE", "GOEXPERIMENT", "GOAMD64", "GOARM", "GOARM64", "GO386", "GOMIPS", "GOMIPS64", "GOPPC64", "GORISCV64", "GOWASM", "CC", "CXX", "PKG_CONFIG":
		return true
	}
	return false
}
