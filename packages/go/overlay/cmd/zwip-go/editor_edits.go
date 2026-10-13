package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/protocol"
)

func editablePath(scopes []scopedSnapshot, path string) bool {
	for _, scope := range scopes {
		if !within(scope.context.Root, path) {
			continue
		}
		relative, err := filepath.Rel(scope.context.Root, path)
		if err != nil {
			continue
		}
		excluded := false
		for _, component := range strings.Split(relative, string(filepath.Separator)) {
			switch component {
			case ".git", ".claude", "node_modules", "vendor":
				excluded = true
			}
		}
		if !excluded {
			return true
		}
	}
	return false
}

func editorTextEdits(ctx context.Context, scopes []scopedSnapshot, snapshot *cache.Snapshot, uri protocol.DocumentURI, edits []protocol.TextEdit) ([]editorEdit, error) {
	if len(edits) == 0 {
		return nil, nil
	}
	path, err := canonical(uri.Path())
	if err != nil {
		return nil, err
	}
	if !editablePath(scopes, path) {
		return nil, fmt.Errorf("edit targets excluded or external source: %s", path)
	}
	fh, err := snapshot.ReadFile(ctx, uri)
	if err != nil {
		return nil, err
	}
	content, err := fh.Content()
	if err != nil {
		return nil, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(content))
	mapper := protocol.NewMapper(uri, content)
	result := make([]editorEdit, 0, len(edits))
	for _, edit := range edits {
		if _, _, err := mapper.RangeOffsets(edit.Range); err != nil {
			return nil, err
		}
		result = append(result, editorEdit{Path: path, Revision: fh.Version(), FileHash: hash, Range: edit.Range, NewText: edit.NewText})
	}
	return normalizeEditorEdits(result)
}

func documentChangesToEdits(ctx context.Context, scopes []scopedSnapshot, snapshot *cache.Snapshot, changes []protocol.DocumentChange) ([]editorEdit, error) {
	var result []editorEdit
	for _, change := range changes {
		if change.TextDocumentEdit == nil {
			return nil, fmt.Errorf("rename requires resource moves; this preview supports text edits only")
		}
		document := change.TextDocumentEdit
		var edits []protocol.TextEdit
		for _, item := range document.Edits {
			switch edit := item.Value.(type) {
			case protocol.TextEdit:
				edits = append(edits, edit)
			case protocol.AnnotatedTextEdit:
				edits = append(edits, edit.TextEdit)
			default:
				return nil, fmt.Errorf("unsupported workspace edit type %T", item.Value)
			}
		}
		converted, err := editorTextEdits(ctx, scopes, snapshot, document.TextDocument.URI, edits)
		if err != nil {
			return nil, err
		}
		result = append(result, converted...)
	}
	return result, nil
}

func normalizeEditorEdits(edits []editorEdit) ([]editorEdit, error) {
	sort.Slice(edits, func(i, j int) bool {
		a, b := edits[i], edits[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if cmp := protocol.CompareRange(a.Range, b.Range); cmp != 0 {
			return cmp < 0
		}
		return a.NewText < b.NewText
	})
	result := make([]editorEdit, 0, len(edits))
	for _, edit := range edits {
		if len(result) > 0 {
			previous := result[len(result)-1]
			if previous.Path == edit.Path {
				if previous.FileHash != edit.FileHash || previous.Revision != edit.Revision {
					return nil, fmt.Errorf("contexts disagree on document snapshot: %s", edit.Path)
				}
				if previous.Range == edit.Range && previous.NewText == edit.NewText {
					continue
				}
				if previous.Range == edit.Range || protocol.ComparePosition(edit.Range.Start, previous.Range.End) < 0 {
					return nil, fmt.Errorf("conflicting or overlapping edits from module contexts: %s", edit.Path)
				}
			}
		}
		result = append(result, edit)
	}
	return result, nil
}
