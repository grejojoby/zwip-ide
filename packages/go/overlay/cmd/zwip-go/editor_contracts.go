package main

type editorQuery struct {
	ID                  string       `json:"id"`
	Operation           string       `json:"operation"`
	Path                string       `json:"path"`
	Position            *position    `json:"position,omitempty"`
	Range               *sourceRange `json:"range,omitempty"`
	DocumentRevision    int32        `json:"documentRevision"`
	WorkspaceGeneration int64        `json:"workspaceGeneration"`
	NewName             string       `json:"newName,omitempty"`
	Query               string       `json:"query,omitempty"`
	SourceContextID     string       `json:"sourceContextId,omitempty"`
}

type editorEdit struct {
	Path     string      `json:"path"`
	Revision int32       `json:"revision"`
	FileHash string      `json:"fileHash"`
	Range    sourceRange `json:"range"`
	NewText  string      `json:"newText"`
}
type editorCompletion struct {
	Label           string       `json:"label"`
	Detail          string       `json:"detail,omitempty"`
	InsertText      string       `json:"insertText"`
	Range           sourceRange  `json:"range"`
	AdditionalEdits []editorEdit `json:"additionalEdits,omitempty"`
}
type editorDiagnostic struct {
	Range    sourceRange `json:"range"`
	Severity string      `json:"severity"`
	Message  string      `json:"message"`
	Source   string      `json:"source,omitempty"`
}
type editorCodeAction struct {
	Title string       `json:"title"`
	Kind  string       `json:"kind,omitempty"`
	Edits []editorEdit `json:"edits"`
}
type editorResult struct {
	ID                  string             `json:"id"`
	DocumentRevision    int32              `json:"documentRevision"`
	WorkspaceGeneration int64              `json:"workspaceGeneration"`
	State               string             `json:"state"`
	Reasons             []string           `json:"reasons"`
	Completions         []editorCompletion `json:"completions,omitempty"`
	Diagnostics         []editorDiagnostic `json:"diagnostics,omitempty"`
	Edits               []editorEdit       `json:"edits,omitempty"`
	Hover               string             `json:"hover,omitempty"`
	Symbols             []sourceLocation   `json:"symbols,omitempty"`
	CodeActions         []editorCodeAction `json:"codeActions,omitempty"`
}
