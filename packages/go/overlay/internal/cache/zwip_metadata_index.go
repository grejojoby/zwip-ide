package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/types"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/gopls/internal/filecache"
	"golang.org/x/tools/internal/packagesinternal"
)

type zwipIndexConfig struct {
	Root, Fingerprint string
	Rebuild           bool
}

var zwipIndexConfigs sync.Map
var zwipMetadataHits sync.Map

// The provider configures the generic workspace identity; no language-specific
// metadata enters the Rust foundation or the IPC initialization contract.
func ZwipConfigureWorkspaceIndex(root, fingerprint string, rebuild bool) {
	zwipIndexConfigs.Store(root, zwipIndexConfig{root, fingerprint, rebuild})
}
func (v *View) ZwipMetadataRestored() bool {
	value, _ := zwipMetadataHits.Load(v)
	return value == true
}

type zwipPackageNode struct {
	Data    json.RawMessage
	Module  *packages.Module
	ForTest string
}
type zwipPackageGraph struct {
	Schema      int
	Roots       []string
	Nodes       []zwipPackageNode
	Files       map[string]string
	Directories map[string]string
}

func zwipHashFile(path string) (string, error) {
	input, err := os.Open(path)
	if os.IsNotExist(err) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	defer input.Close()
	sum := sha256.New()
	if _, err = io.Copy(sum, input); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}
func zwipDirectory(path string) (string, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", err
	}
	sum := sha256.New()
	for _, entry := range entries {
		fmt.Fprintf(sum, "%s:%d\x00", entry.Name(), entry.Type())
		if entry.Type()&os.ModeSymlink != 0 {
			target, err := filepath.EvalSymlinks(filepath.Join(path, entry.Name()))
			if err != nil {
				return "", err
			}
			fmt.Fprint(sum, target)
		}
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// go list materializes test-main sources in the content-addressed Go build
// cache during loading. Their timestamps are necessarily newer than the load,
// and unrelated writes to the same bucket must not invalidate their contents.
// Original workspace/dependency sources are still checked independently.
func zwipGeneratedFile(cfg *packages.Config, path string) bool {
	name := filepath.Base(path)
	if len(name) != 66 || !strings.HasSuffix(name, "-d") || filepath.Base(filepath.Dir(path)) != name[:2] {
		return false
	}
	if _, err := hex.DecodeString(name[:64]); err != nil {
		return false
	}
	for _, env := range cfg.Env {
		if strings.HasPrefix(env, "GOCACHE=") && filepath.Clean(strings.TrimPrefix(env, "GOCACHE=")) == filepath.Dir(filepath.Dir(path)) {
			return true
		}
	}
	return false
}
func zwipInputFiles(cfg *packages.Config, roots []*packages.Package) (map[string]string, map[string]string, error) {
	paths := map[string]bool{}
	dirs := map[string]string{}
	add := func(path string) {
		if path != "" {
			paths[path] = true
		}
	}
	visited := map[string]bool{}
	var visit func(*packages.Package) error
	visit = func(pkg *packages.Package) error {
		if visited[pkg.ID] {
			return nil
		}
		visited[pkg.ID] = true
		if len(pkg.Errors) > 0 || len(packagesinternal.GetDepsErrors(pkg)) > 0 {
			return fmt.Errorf("incomplete package metadata")
		}
		originals := map[string]bool{}
		for _, source := range pkg.GoFiles {
			originals[source] = true
		}
		for _, source := range pkg.CompiledGoFiles {
			if !originals[source] {
				// cgo may read external headers and toolchain inputs not exposed by
				// go/packages. Refresh that graph through the live compiler driver.
				return fmt.Errorf("generated compiler inputs require live package metadata")
			}
		}
		for _, list := range [][]string{pkg.GoFiles, pkg.CompiledGoFiles, pkg.IgnoredFiles, pkg.OtherFiles, pkg.EmbedFiles} {
			for _, path := range list {
				add(path)
				dir := filepath.Dir(path)
				if _, ok := dirs[dir]; !ok && !zwipGeneratedFile(cfg, path) {
					value, err := zwipDirectory(dir)
					if err != nil {
						return err
					}
					dirs[dir] = value
				}
			}
		}
		for module := pkg.Module; module != nil; module = module.Replace {
			add(module.GoMod)
			if module.Dir != "" {
				add(filepath.Join(module.Dir, "go.mod"))
				add(filepath.Join(module.Dir, "go.sum"))
			}
		}
		for _, dep := range pkg.Imports {
			if err := visit(dep); err != nil {
				return err
			}
		}
		return nil
	}
	for _, pkg := range roots {
		if err := visit(pkg); err != nil {
			return nil, nil, err
		}
	}
	// Directory entries detect new files and packages, including offline additions.
	err := filepath.WalkDir(cfg.Dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if path != cfg.Dir {
			switch entry.Name() {
			case ".git", "node_modules", "target", "dist", ".next", ".cache":
				return filepath.SkipDir
			}
		}
		value, err := zwipDirectory(path)
		if err != nil {
			return err
		}
		dirs[path] = value
		for _, name := range []string{"go.mod", "go.sum", "go.work", "go.work.sum"} {
			add(filepath.Join(path, name))
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	for _, env := range cfg.Env {
		key, value, ok := strings.Cut(env, "=")
		if !ok {
			continue
		}
		if key == "GOWORK" && value != "off" {
			add(value)
			add(value + ".sum")
		}
		if key == "GOROOT" {
			add(filepath.Join(value, "bin/go"))
			add(filepath.Join(value, "go.env"))
		}
		if key == "GOENV" && value != "off" {
			add(value)
		}
	}
	if dir, err := os.UserConfigDir(); err == nil {
		add(filepath.Join(dir, "go/env"))
	}
	files := map[string]string{}
	for path := range paths {
		value, err := zwipHashFile(path)
		if err != nil {
			return nil, nil, err
		}
		files[path] = value
	}
	return files, dirs, nil
}
func (graph *zwipPackageGraph) valid() bool {
	if graph.Schema != 1 || len(graph.Nodes) == 0 || len(graph.Nodes) > 100000 {
		return false
	}
	for path, expected := range graph.Files {
		actual, err := zwipHashFile(path)
		if err != nil || actual != expected {
			return false
		}
	}
	for path, expected := range graph.Directories {
		actual, err := zwipDirectory(path)
		if err != nil || actual != expected {
			return false
		}
	}
	return true
}
func zwipEncodeGraph(cfg *packages.Config, roots []*packages.Package) (*zwipPackageGraph, error) {
	files, dirs, err := zwipInputFiles(cfg, roots)
	if err != nil {
		return nil, err
	}
	graph := &zwipPackageGraph{Schema: 1, Files: files, Directories: dirs}
	seen := map[string]bool{}
	var visit func(*packages.Package) error
	visit = func(pkg *packages.Package) error {
		if seen[pkg.ID] {
			return nil
		}
		seen[pkg.ID] = true
		data, err := json.Marshal(pkg)
		if err != nil {
			return err
		}
		graph.Nodes = append(graph.Nodes, zwipPackageNode{data, pkg.Module, pkg.ForTest})
		keys := make([]string, 0, len(pkg.Imports))
		for key := range pkg.Imports {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if err := visit(pkg.Imports[key]); err != nil {
				return err
			}
		}
		return nil
	}
	for _, pkg := range roots {
		graph.Roots = append(graph.Roots, pkg.ID)
		if err := visit(pkg); err != nil {
			return nil, err
		}
	}
	return graph, nil
}
func (graph *zwipPackageGraph) decode(arch string) ([]*packages.Package, error) {
	nodes := map[string]*packages.Package{}
	for _, record := range graph.Nodes {
		var pkg packages.Package
		if err := json.Unmarshal(record.Data, &pkg); err != nil {
			return nil, err
		}
		if pkg.ID == "" || nodes[pkg.ID] != nil {
			return nil, fmt.Errorf("invalid package identity")
		}
		pkg.Module = record.Module
		pkg.ForTest = record.ForTest
		pkg.TypesSizes = types.SizesFor("gc", arch)
		if pkg.TypesSizes == nil {
			return nil, fmt.Errorf("unsupported cached target")
		}
		nodes[pkg.ID] = &pkg
	}
	for _, pkg := range nodes {
		for key, dep := range pkg.Imports {
			actual := nodes[dep.ID]
			if actual == nil {
				return nil, fmt.Errorf("incomplete cached import graph")
			}
			pkg.Imports[key] = actual
		}
	}
	roots := make([]*packages.Package, 0, len(graph.Roots))
	for _, id := range graph.Roots {
		pkg := nodes[id]
		if pkg == nil {
			return nil, fmt.Errorf("missing cached root")
		}
		roots = append(roots, pkg)
	}
	return roots, nil
}
func zwipNormalizedFlags(flags []string) []string {
	result := append([]string(nil), flags...)
	for i, flag := range result {
		if strings.HasPrefix(flag, "-overlay=") {
			var overlay struct{ Replace map[string]string }
			data, err := os.ReadFile(strings.TrimPrefix(flag, "-overlay="))
			if err != nil {
				return result
			}
			if json.Unmarshal(data, &overlay) != nil {
				return result
			}
			for path, replacement := range overlay.Replace {
				sum, err := zwipHashFile(replacement)
				if err != nil {
					return result
				}
				overlay.Replace[path] = sum
			}
			normalized, _ := json.Marshal(overlay)
			result[i] = "-overlay=" + string(normalized)
		}
	}
	return result
}

// Loading metadata races external editors. Refuse publication if any input's
// modification/change time is newer than the start of the load. A later pass
// can publish a stable snapshot; the live result keeps upstream semantics.
func zwipStableSince(cfg *packages.Config, graph *zwipPackageGraph, started time.Time) bool {
	check := func(path string) bool {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			return true
		}
		if err != nil || info.ModTime().After(started) {
			return false
		}
		value := reflect.Indirect(reflect.ValueOf(info.Sys()))
		if !value.IsValid() || value.Kind() != reflect.Struct {
			return false
		}
		for _, name := range []string{"Ctim", "Ctimespec"} {
			field := value.FieldByName(name)
			if field.IsValid() && field.Kind() == reflect.Struct {
				sec, nsec := field.FieldByName("Sec"), field.FieldByName("Nsec")
				if sec.IsValid() && nsec.IsValid() {
					return !time.Unix(sec.Int(), nsec.Int()).After(started)
				}
			}
		}
		return false
	}
	for path, value := range graph.Files {
		if value != "missing" && !zwipGeneratedFile(cfg, path) && !check(path) {
			return false
		}
	}
	for path := range graph.Directories {
		if !check(path) {
			return false
		}
	}
	return true
}
func (s *Snapshot) zwipLoadPackages(cfg *packages.Config, query ...string) ([]*packages.Package, error) {
	// Custom drivers may consume arbitrary environment state or return non-gc sizes.
	if strings.Contains(strings.Join(cfg.BuildFlags, " "), "gccgo") {
		return packages.Load(cfg, query...)
	}
	for _, env := range cfg.Env {
		if strings.HasPrefix(env, "GOPACKAGESDRIVER=") && env != "GOPACKAGESDRIVER=off" && env != "GOPACKAGESDRIVER=" {
			return packages.Load(cfg, query...)
		}
	}
	var config zwipIndexConfig
	zwipIndexConfigs.Range(func(_, value any) bool {
		candidate := value.(zwipIndexConfig)
		rel, err := filepath.Rel(candidate.Root, cfg.Dir)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && len(candidate.Root) > len(config.Root) {
			config = candidate
		}
		return true
	})
	// Hash semantic build inputs, not session IDs, window IDs or progress state.
	env := map[string]string{}
	for _, entry := range cfg.Env {
		key, value, ok := strings.Cut(entry, "=")
		if key == "GOFLAGS" && strings.Contains(value, "gccgo") {
			return packages.Load(cfg, query...)
		}
		if ok && (strings.HasPrefix(key, "GO") || strings.HasPrefix(key, "CGO_") || key == "PATH" || key == "HOME" || key == "CC" || key == "CXX" || key == "PKG_CONFIG" || key == "CPATH" || key == "LIBRARY_PATH" || key == "LD_LIBRARY_PATH" || key == "SDKROOT" || key == "MACOSX_DEPLOYMENT_TARGET") {
			env[key] = value
		}
	}
	identity, _ := json.Marshal([]any{1, cfg.Dir, cfg.Mode, cfg.Tests, env, zwipNormalizedFlags(cfg.BuildFlags), cfg.Overlay, query, s.view.GOARCH(), s.view.GoVersionString(), config.Fingerprint})
	key := sha256.Sum256(identity)
	if !config.Rebuild {
		if data, err := filecache.Get("zwip-workspace-graph", key); err == nil && len(data) <= 64*1024*1024 {
			var graph zwipPackageGraph
			if json.Unmarshal(data, &graph) == nil && graph.valid() {
				if roots, err := graph.decode(s.view.GOARCH()); err == nil {
					zwipMetadataHits.Store(s.view, true)
					return roots, nil
				}
			}
		}
	}
	zwipMetadataHits.Store(s.view, false)
	started := time.Now()
	roots, err := packages.Load(cfg, query...)
	if err == nil && cfg.Context.Err() == nil {
		if graph, encodeErr := zwipEncodeGraph(cfg, roots); encodeErr == nil && zwipStableSince(cfg, graph, started) && graph.valid() {
			if data, encodeErr := json.Marshal(graph); encodeErr == nil {
				_ = filecache.Set("zwip-workspace-graph", key, data)
			}
		}
	}
	return roots, err
}
