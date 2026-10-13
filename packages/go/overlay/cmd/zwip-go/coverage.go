package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/modfile"
	"golang.org/x/tools/cover"
	"golang.org/x/tools/gopls/internal/protocol"
)

type coverageBlock struct {
	Range      sourceRange `json:"range"`
	Count      int         `json:"count"`
	Statements int         `json:"statements"`
}
type coverageFile struct {
	Path              string          `json:"path"`
	FileHash          string          `json:"fileHash"`
	CoveredStatements int             `json:"coveredStatements"`
	TotalStatements   int             `json:"totalStatements"`
	Percent           float64         `json:"percent"`
	Blocks            []coverageBlock `json:"blocks"`
}
type coverageSummary struct {
	Files   []coverageFile `json:"files"`
	Percent float64        `json:"percent"`
}

func readCoverage(profile string, c buildContext) (*coverageSummary, error) {
	profiles, err := cover.ParseProfiles(profile)
	if err != nil {
		return nil, err
	}
	manifest, err := os.ReadFile(filepath.Join(c.Root, "go.mod"))
	if err != nil {
		return nil, err
	}
	module := modfile.ModulePath(manifest)
	result := &coverageSummary{Files: []coverageFile{}}
	covered, total := 0, 0
	for _, p := range profiles {
		if !strings.HasPrefix(p.FileName, module+"/") {
			return nil, fmt.Errorf("coverage path outside module: %s", p.FileName)
		}
		path, err := canonical(filepath.Join(c.Root, strings.TrimPrefix(p.FileName, module+"/")))
		if err != nil {
			return nil, err
		}
		if !within(c.Root, path) {
			return nil, fmt.Errorf("coverage path escapes module")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		mapper := protocol.NewMapper(protocol.URIFromPath(path), content)
		file := coverageFile{Path: path, FileHash: fmt.Sprintf("%x", sha256.Sum256(content)), Blocks: []coverageBlock{}}
		for _, block := range p.Blocks {
			start, err := mapper.LineCol8Position(block.StartLine, block.StartCol)
			if err != nil {
				return nil, err
			}
			end, err := mapper.LineCol8Position(block.EndLine, block.EndCol)
			if err != nil {
				return nil, err
			}
			file.Blocks = append(file.Blocks, coverageBlock{Range: sourceRange{Start: start, End: end}, Count: block.Count, Statements: block.NumStmt})
			file.TotalStatements += block.NumStmt
			if block.Count > 0 {
				file.CoveredStatements += block.NumStmt
			}
		}
		if file.TotalStatements > 0 {
			file.Percent = 100 * float64(file.CoveredStatements) / float64(file.TotalStatements)
		}
		covered += file.CoveredStatements
		total += file.TotalStatements
		result.Files = append(result.Files, file)
	}
	if total > 0 {
		result.Percent = 100 * float64(covered) / float64(total)
	}
	return result, nil
}
