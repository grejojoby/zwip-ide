package main

import "golang.org/x/tools/gopls/internal/protocol"

type position = protocol.Position
type sourceRange = protocol.Range

type buildContext struct {
	ID         string `json:"id"`
	Root       string `json:"root"`
	Language   string `json:"language"`
	ConfigPath string `json:"configPath"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	// Background type-checking progress after "workspace.index"; both zero until it starts.
	Indexed          int            `json:"indexed,omitempty"`
	Packages         int            `json:"packages,omitempty"`
	GoWork           string         `json:"goWork,omitempty"`
	ProfileID        string         `json:"profileId,omitempty"`
	Settings         map[string]any `json:"settings,omitempty"`
	profile          goBuildSettings
	protectedOverlay string
}
type initializeParams struct {
	Root       string         `json:"root"`
	Contexts   []buildContext `json:"contexts"`
	Generation int64          `json:"generation"`
}
type documentUpdate struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Revision int32  `json:"revision"`
}
type navigationQuery struct {
	ID                  string   `json:"id"`
	Operation           string   `json:"operation"`
	Path                string   `json:"path"`
	Position            position `json:"position"`
	DocumentRevision    int32    `json:"documentRevision"`
	WorkspaceGeneration int64    `json:"workspaceGeneration"`
	ContextIDs          []string `json:"contextIds,omitempty"`
	SourceContextID     string   `json:"sourceContextId,omitempty"`
}
type sourceLocation struct {
	Path         string      `json:"path"`
	Range        sourceRange `json:"range"`
	Name         string      `json:"name"`
	Preview      string      `json:"preview"`
	ContextIDs   []string    `json:"contextIds"`
	Relationship string      `json:"relationship"`
}
type navigationBatch struct {
	ID                  string           `json:"id"`
	DocumentRevision    int32            `json:"documentRevision"`
	WorkspaceGeneration int64            `json:"workspaceGeneration"`
	State               string           `json:"state"`
	Locations           []sourceLocation `json:"locations"`
	SearchedContexts    int              `json:"searchedContexts"`
	TotalContexts       int              `json:"totalContexts"`
	Reasons             []string         `json:"reasons"`
}
