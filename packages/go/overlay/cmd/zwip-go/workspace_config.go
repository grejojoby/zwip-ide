package main

import (
	"fmt"
	"go/version"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/modfile"
)

// Explicit workspace files inside the opened project may govern modules they
// list. Ambient GOWORK or an ancestor outside the project is never inherited.
func discoverGoWork(root, module string) (string, error) {
	for dir := module; within(root, dir); dir = filepath.Dir(dir) {
		path := filepath.Join(dir, "go.work")
		data, err := os.ReadFile(path)
		if err == nil {
			path, err = canonical(path)
			if err != nil || !within(root, path) {
				return "", fmt.Errorf("go.work escapes the opened workspace")
			}
			work, err := modfile.ParseWork(path, data, nil)
			if err != nil {
				return "", fmt.Errorf("parse %s: %w", path, err)
			}
			for _, use := range work.Use {
				used := use.Path
				if !filepath.IsAbs(used) {
					used = filepath.Join(dir, used)
				}
				used, err = canonical(used)
				if err != nil {
					return "", fmt.Errorf("go.work use %s: %w", use.Path, err)
				}
				if used == module {
					return canonical(path)
				}
			}
			// The nearest file does not include this module. Preserve its own
			// graph rather than silently forcing it into someone else's workfile.
			return "", nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if dir == root {
			break
		}
	}
	return "", nil
}

func contextGoWork(c buildContext) string {
	if c.GoWork != "" {
		return c.GoWork
	}
	return "off"
}
func contextBuildFlags(c buildContext) (flags []string) {
	defer func() {
		if c.profile.HasTags {
			flags = append(flags, "-tags="+strings.Join(c.profile.Tags, ","))
		}
		if c.protectedOverlay != "" {
			flags = append(flags, "-overlay="+c.protectedOverlay)
		}
	}()
	if c.GoWork == "" {
		return moduleBuildFlags(c.Root)
	}
	var mode string
	for _, flag := range strings.Fields(os.Getenv("GOFLAGS")) {
		if flag == "-mod=vendor" {
			mode = flag
		}
		if flag == "-mod=readonly" || flag == "-mod=mod" {
			mode = "-mod=readonly"
		}
	}
	if mode != "" {
		return []string{mode}
	}
	data, err := os.ReadFile(c.GoWork)
	if err == nil {
		work, err := modfile.ParseWork(c.GoWork, data, nil)
		if err == nil && work.Go != nil && version.Compare("go"+work.Go.Version, "go1.22") >= 0 {
			if info, err := os.Stat(filepath.Join(filepath.Dir(c.GoWork), "vendor")); err == nil && info.IsDir() {
				return []string{"-mod=vendor"}
			}
		}
	}
	return []string{"-mod=readonly"}
}
