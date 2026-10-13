package main

import (
	"context"
	"fmt"
	"strings"

	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/golang/completion"
	"golang.org/x/tools/gopls/internal/protocol"
)

func (w *worker) editor(ctx context.Context, q editorQuery) (result editorResult) {
	result = editorResult{ID: q.ID, DocumentRevision: q.DocumentRevision, WorkspaceGeneration: q.WorkspaceGeneration, State: "complete", Reasons: []string{}}
	fail := func(err error) editorResult {
		result.State = "failed"
		result.Reasons = append(result.Reasons, err.Error())
		result.Edits = nil
		result.CodeActions = nil
		return result
	}
	switch q.Operation {
	case "completion", "hover", "diagnostics", "format", "rename", "symbols", "codeActions":
	default:
		result.State = "unsupported"
		result.Reasons = append(result.Reasons, "unsupported Go editor operation: "+q.Operation)
		return result
	}
	if (q.Operation == "completion" || q.Operation == "hover" || q.Operation == "rename") && q.Position == nil {
		return fail(fmt.Errorf("position is required for %s", q.Operation))
	}
	if ctx.Err() != nil {
		result.State = "canceled"
		result.Reasons = append(result.Reasons, "request canceled")
		return result
	}
	scopes, path, epoch, err := w.snapshots(navigationQuery{Path: q.Path, DocumentRevision: q.DocumentRevision, WorkspaceGeneration: q.WorkspaceGeneration, SourceContextID: q.SourceContextID})
	if err != nil {
		return fail(err)
	}
	defer func() {
		if ctx.Err() != nil || w.epoch.Load() != epoch {
			result.State = "canceled"
			result.Reasons = append(result.Reasons, "request canceled or its document snapshot changed")
			result.Edits = nil
			result.CodeActions = nil
			result.Completions = nil
		}
		for _, scope := range scopes {
			if scope.release != nil {
				scope.release()
			}
		}
	}()
	source, uri, err := sourceContext(ctx, scopes, path, q.SourceContextID)
	if err != nil {
		return fail(err)
	}
	if !editablePath(scopes, path) {
		switch q.Operation {
		case "hover", "diagnostics", "symbols":
		default:
			return fail(fmt.Errorf("dependency source is read-only; editor edits are unavailable"))
		}
	}
	if source == nil || source.snapshot == nil {
		if source != nil && source.context.State == "loading" {
			result.State = "partial"
			result.Reasons = append(result.Reasons, source.context.ID+": indexing is still loading; retry after workspace.status reports ready")
			return result
		}
		return fail(fmt.Errorf("source Go build context is unavailable"))
	}
	snapshot := source.snapshot
	if q.Operation != "format" && q.Operation != "symbols" {
		if err := requireContextSource(ctx, source, uri); err != nil {
			return fail(err)
		}
	}
	fh, err := snapshot.ReadFile(ctx, uri)
	if err != nil {
		return fail(err)
	}
	switch q.Operation {
	case "completion":
		candidates, selection, err := completion.Completion(ctx, snapshot, fh, *q.Position, protocol.CompletionContext{TriggerKind: protocol.Invoked})
		if err != nil {
			return fail(err)
		}
		if selection == nil {
			return result
		}
		rng, err := selection.Range()
		if err != nil {
			return fail(err)
		}
		deep := 0
		for _, candidate := range candidates {
			if candidate.InsertText == "" {
				continue
			}
			if candidate.Depth > 0 {
				if !snapshot.Options().DeepCompletion || deep >= completion.MaxDeepCompletions {
					continue
				}
				deep++
			}
			additional, err := editorTextEdits(ctx, scopes, snapshot, uri, candidate.AdditionalTextEdits)
			if err != nil {
				return fail(err)
			}
			result.Completions = append(result.Completions, editorCompletion{Label: candidate.Label, Detail: candidate.Detail, InsertText: candidate.InsertText, Range: rng, AdditionalEdits: additional})
		}
	case "hover":
		rng := sourceRange{Start: *q.Position, End: *q.Position}
		if q.Range != nil {
			rng = *q.Range
		}
		hover, err := golang.Hover(ctx, snapshot, fh, rng, nil)
		if err != nil {
			return fail(err)
		}
		if hover != nil {
			result.Hover = hover.Contents.Value
		}
	case "diagnostics":
		diagnostics, err := golang.DiagnoseFile(ctx, snapshot, uri)
		if err != nil {
			return fail(err)
		}
		for _, diagnostic := range diagnostics {
			severity := "information"
			if diagnostic.Severity == protocol.SeverityError {
				severity = "error"
			} else if diagnostic.Severity == protocol.SeverityWarning {
				severity = "warning"
			}
			result.Diagnostics = append(result.Diagnostics, editorDiagnostic{Range: diagnostic.Range, Severity: severity, Message: diagnostic.Message, Source: string(diagnostic.Source)})
		}
	case "format":
		edits, err := golang.Format(ctx, snapshot, fh)
		if err != nil {
			return fail(err)
		}
		result.Edits, err = editorTextEdits(ctx, scopes, snapshot, uri, edits)
		if err != nil {
			return fail(err)
		}
	case "symbols":
		symbols, err := golang.DocumentSymbols(ctx, snapshot, fh)
		if err != nil {
			return fail(err)
		}
		var collect func([]protocol.DocumentSymbol) error
		collect = func(nodes []protocol.DocumentSymbol) error {
			for _, symbol := range nodes {
				if q.Query == "" || strings.Contains(strings.ToLower(symbol.Name), strings.ToLower(q.Query)) {
					loc, err := describeLocation(ctx, snapshot, protocol.Location{URI: uri, Range: symbol.SelectionRange}, source.context.ID, "document symbol")
					if err != nil {
						return err
					}
					loc.Name = symbol.Name
					result.Symbols = append(result.Symbols, loc)
				}
				if err := collect(symbol.Children); err != nil {
					return err
				}
			}
			return nil
		}
		if err := collect(symbols); err != nil {
			return fail(err)
		}
	case "codeActions":
		if q.Query != "" && q.Query != "source.organizeImports" {
			result.State = "unsupported"
			result.Reasons = append(result.Reasons, "Go codeActions currently supports source.organizeImports")
			return result
		}
		edits, err := golang.ZwipOrganizeImports(ctx, snapshot, fh)
		if err != nil {
			return fail(err)
		}
		converted, err := editorTextEdits(ctx, scopes, snapshot, uri, edits)
		if err != nil {
			return fail(err)
		}
		if len(converted) > 0 {
			result.CodeActions = []editorCodeAction{{Title: "Organize Imports", Kind: "source.organizeImports", Edits: converted}}
		}
	case "rename":
		result.Edits, err = editorRename(ctx, scopes, source, fh, *q.Position, q.NewName)
		if err != nil {
			return fail(err)
		}
	}
	return result
}
