package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func main() {
	if err := configurePackageCache(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := serveWithContext(ctx, os.Stdin, os.Stdout); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func serve(input io.Reader, output io.Writer) error {
	return serveWithContext(context.Background(), input, output)
}

func serveWithContext(lifetime context.Context, input io.Reader, output io.Writer) error {
	worker := newWorker()
	defer worker.close()
	var writes, pendingMu sync.Mutex
	var queries sync.WaitGroup
	pending := map[string]context.CancelFunc{}
	cancelAll := func() {
		pendingMu.Lock()
		defer pendingMu.Unlock()
		for _, cancel := range pending {
			cancel()
		}
	}
	defer func() { cancelAll(); queries.Wait() }()
	stopSignal := context.AfterFunc(lifetime, func() {
		cancelAll()
		// Terminate owned child groups even if initialization or stdin reads
		// are blocked when the host's process supervisor sends SIGTERM.
		worker.stopTools()
		if closer, ok := input.(io.Closer); ok {
			_ = closer.Close()
		}
	})
	defer stopSignal()
	send := func(id json.RawMessage, result any, err error, code int) {
		if len(id) == 0 {
			return
		}
		response := rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
		if err != nil {
			response.Result = nil
			response.Error = &rpcError{Code: code, Message: err.Error()}
		}
		writes.Lock()
		defer writes.Unlock()
		if encodeErr := json.NewEncoder(output).Encode(response); encodeErr != nil {
			fmt.Fprintln(os.Stderr, encodeErr)
		}
	}
	launch := func(rawID json.RawMessage, work func(context.Context) any) {
		id := append(json.RawMessage(nil), rawID...)
		key := string(id)
		pendingMu.Lock()
		if _, exists := pending[key]; exists {
			pendingMu.Unlock()
			send(id, nil, fmt.Errorf("request ID already pending"), -32600)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		pending[key] = cancel
		pendingMu.Unlock()
		queries.Add(1)
		go func() {
			defer queries.Done()
			defer cancel()
			result := work(ctx)
			pendingMu.Lock()
			delete(pending, key)
			pendingMu.Unlock()
			send(id, result, nil, 0)
		}()
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for scanner.Scan() {
		var request rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			send(json.RawMessage("null"), nil, err, -32700)
			continue
		}
		if request.JSONRPC != "2.0" {
			send(request.ID, nil, fmt.Errorf("jsonrpc must be 2.0"), -32600)
			continue
		}
		if request.Method == "$/cancelRequest" {
			var params struct {
				ID json.RawMessage `json:"id"`
			}
			if json.Unmarshal(request.Params, &params) == nil {
				pendingMu.Lock()
				cancel := pending[string(params.ID)]
				if cancel != nil {
					cancel()
				}
				pendingMu.Unlock()
			}
			continue
		}
		switch request.Method {
		case "initialize":
			var params initializeParams
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			cancelAll()
			contexts, err := worker.initializeAsync(lifetime, params)
			send(request.ID, map[string]any{"contexts": contexts, "generation": params.Generation}, err, -32001)
		case "workspace.status":
			send(request.ID, worker.status(), nil, 0)
		case "document.update":
			var params documentUpdate
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			err := worker.update(context.Background(), params)
			send(request.ID, map[string]any{"revision": params.Revision}, err, -32002)
		case "navigation.query":
			var params navigationQuery
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			launch(request.ID, func(ctx context.Context) any {
				return worker.queryProgress(ctx, params, func(batch navigationBatch) {
					writes.Lock()
					defer writes.Unlock()
					if err := json.NewEncoder(output).Encode(map[string]any{"jsonrpc": "2.0", "method": "navigation.progress", "params": batch}); err != nil {
						fmt.Fprintln(os.Stderr, err)
					}
				})
			})
		case "document.close":
			var params struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			err := worker.closeDocument(lifetime, params.Path)
			send(request.ID, map[string]bool{"closed": err == nil}, err, -32002)
		case "workspace.symbols":
			var params workspaceSymbolQuery
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			launch(request.ID, func(ctx context.Context) any { return worker.workspaceSymbols(ctx, params) })
		case "editor.request":
			var params editorQuery
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			launch(request.ID, func(ctx context.Context) any { return worker.editor(ctx, params) })
		case "tool.request":
			var params toolQuery
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			launch(request.ID, func(ctx context.Context) any { return worker.tool(ctx, params) })
		case "workspace.changed":
			var params struct {
				Paths []string `json:"paths"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				send(request.ID, nil, err, -32602)
				continue
			}
			err := worker.changed(context.Background(), params.Paths)
			send(request.ID, map[string]bool{"updated": err == nil}, err, -32003)
		case "shutdown":
			cancelAll()
			queries.Wait()
			worker.close()
			send(request.ID, map[string]bool{"shutdown": true}, nil, 0)
			return nil
		default:
			send(request.ID, nil, fmt.Errorf("unknown method: %s", request.Method), -32601)
		}
	}
	return scanner.Err()
}
