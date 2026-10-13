package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/tools/gopls/internal/file"
	"golang.org/x/tools/gopls/internal/protocol"
)

type sumProtection struct {
	dir      string
	copies   map[string]string
	revision int32
}

// Go 1.25 may write go.work.sum even with -mod=readonly. A Go file overlay
// prevents those writes: the Go command reports a needed checksum update
// instead of changing a project file. The explicit go.work graph is untouched.
func protectWorkspaceSums(contexts []buildContext) (*sumProtection, []file.Modification, error) {
	paths := map[string]bool{}
	for _, c := range contexts {
		if c.GoWork != "" {
			paths[c.GoWork+".sum"] = true
		}
	}
	if len(paths) == 0 {
		return nil, nil, nil
	}
	dir, err := os.MkdirTemp("", "zwip-go-sums-")
	if err != nil {
		return nil, nil, err
	}
	p := &sumProtection{dir: dir, copies: map[string]string{}, revision: 1}
	var modifications []file.Modification
	for path := range paths {
		copyPath := filepath.Join(dir, fmt.Sprintf("%d.sum", len(p.copies)))
		p.copies[path] = copyPath
		content, err := p.refresh(path)
		if err != nil {
			os.RemoveAll(dir)
			return nil, nil, err
		}
		modifications = append(modifications, file.Modification{URI: protocol.URIFromPath(path), Action: file.Open, Version: p.revision, Text: content, LanguageID: "go.sum"})
	}
	content, err := json.Marshal(map[string]any{"Replace": p.copies})
	if err != nil {
		os.RemoveAll(dir)
		return nil, nil, err
	}
	overlay := filepath.Join(dir, "overlay.json")
	if err := os.WriteFile(overlay, content, 0600); err != nil {
		os.RemoveAll(dir)
		return nil, nil, err
	}
	for i := range contexts {
		if contexts[i].GoWork != "" {
			contexts[i].protectedOverlay = overlay
		}
	}
	return p, modifications, nil
}

func (p *sumProtection) refresh(path string) ([]byte, error) {
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	// A semantically inert blank line keeps gopls from marking this protective
	// overlay as saved and omitting it when combining unsaved source overlays.
	content = append(content, '\n')
	// Atomically replace the private copy: a concurrent Go command must see
	// either complete version, never a partially rewritten checksum file.
	temporary, err := os.CreateTemp(p.dir, "sum-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return nil, err
	}
	if err := temporary.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(temporary.Name(), p.copies[path]); err != nil {
		return nil, err
	}
	return content, nil
}
