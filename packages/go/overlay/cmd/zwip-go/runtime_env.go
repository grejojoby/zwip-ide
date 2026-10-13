package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Core supplies one language-neutral cache directory. Language-specific SDK
// and cache environment belongs to this installable package. Direct adapter
// invocations without that directory retain their explicit Go cache settings.
func configurePackageCache() error {
	root := os.Getenv("ZWIP_PACKAGE_CACHE")
	if root == "" {
		return nil
	}
	if !filepath.IsAbs(root) {
		return fmt.Errorf("ZWIP_PACKAGE_CACHE must be absolute")
	}
	for key, name := range map[string]string{"GOPLSCACHE": "gopls", "GOCACHE": "go-build"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(path, 0700); err != nil {
			return fmt.Errorf("configure %s: %w", key, err)
		}
		if err := os.Setenv(key, path); err != nil {
			return err
		}
	}
	return nil
}
