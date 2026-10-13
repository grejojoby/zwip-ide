package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"
)

type goBuildSettings struct {
	GOOS       string
	GOARCH     string
	Tags       []string
	HasTags    bool
	CGOEnabled *bool
}

func parseGoBuildSettings(settings map[string]any) (goBuildSettings, error) {
	var profile goBuildSettings
	for key, value := range settings {
		switch key {
		case "goos", "goarch":
			text, ok := value.(string)
			if !ok || text == "" || strings.IndexFunc(text, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') }) >= 0 {
				return profile, fmt.Errorf("%s must be a nonempty lowercase Go target name", key)
			}
			if key == "goos" {
				profile.GOOS = text
			} else {
				profile.GOARCH = text
			}
		case "cgoEnabled":
			flag, ok := value.(bool)
			if !ok {
				return profile, fmt.Errorf("cgoEnabled must be a boolean")
			}
			profile.CGOEnabled = &flag
		case "tags":
			data, err := json.Marshal(value)
			if err != nil || string(data) == "null" || json.Unmarshal(data, &profile.Tags) != nil {
				return profile, fmt.Errorf("tags must be an array of build-tag strings")
			}
			profile.HasTags = true
			seen := map[string]bool{}
			for _, tag := range profile.Tags {
				if tag == "" || strings.IndexFunc(tag, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '.' }) >= 0 || seen[tag] {
					return profile, fmt.Errorf("invalid or duplicate build tag: %q", tag)
				}
				seen[tag] = true
			}
			sort.Strings(profile.Tags)
		default:
			return profile, fmt.Errorf("unsupported Go profile setting: %s", key)
		}
	}
	return profile, nil
}

// Validate target pairs against the configured SDK, never a hand-maintained
// list. go env also preserves the SDK's existing default target configuration.
func validateGoProfileTargets(ctx context.Context, goBinary string, contexts []buildContext) error {
	needed := false
	for _, c := range contexts {
		needed = needed || c.profile.GOOS != "" || c.profile.GOARCH != ""
	}
	if !needed {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	run := func(args ...string) ([]byte, error) {
		command := exec.CommandContext(ctx, goBinary, args...)
		command.Env = append(os.Environ(), "GOWORK=off", "GOTOOLCHAIN=local", "GOROOT="+filepath.Dir(filepath.Dir(goBinary)))
		output, err := command.CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("Go profile target validation: %w: %s", err, output)
		}
		return output, nil
	}
	data, err := run("env", "-json", "GOOS", "GOARCH")
	if err != nil {
		return err
	}
	var baseline struct{ GOOS, GOARCH string }
	if err := json.Unmarshal(data, &baseline); err != nil {
		return err
	}
	data, err = run("tool", "dist", "list", "-json")
	if err != nil {
		return err
	}
	var ports []struct {
		GOOS, GOARCH string
		CgoSupported bool
	}
	if err := json.Unmarshal(data, &ports); err != nil {
		return err
	}
	for _, c := range contexts {
		if c.profile.GOOS == "" && c.profile.GOARCH == "" {
			continue
		}
		goos, goarch := c.profile.GOOS, c.profile.GOARCH
		if goos == "" {
			goos = baseline.GOOS
		}
		if goarch == "" {
			goarch = baseline.GOARCH
		}
		found := false
		for _, port := range ports {
			if port.GOOS == goos && port.GOARCH == goarch {
				found = true
				if c.profile.CGOEnabled != nil && *c.profile.CGOEnabled && !port.CgoSupported {
					return fmt.Errorf("context %s: cgo is unsupported for %s/%s", c.ID, goos, goarch)
				}
				break
			}
		}
		if !found {
			return fmt.Errorf("context %s: unsupported Go target %s/%s", c.ID, goos, goarch)
		}
	}
	return nil
}

func profileEnvironment(c buildContext) map[string]string {
	env := map[string]string{}
	if c.profile.GOOS != "" {
		env["GOOS"] = c.profile.GOOS
	}
	if c.profile.GOARCH != "" {
		env["GOARCH"] = c.profile.GOARCH
	}
	if c.profile.CGOEnabled != nil {
		env["CGO_ENABLED"] = "0"
		if *c.profile.CGOEnabled {
			env["CGO_ENABLED"] = "1"
		}
	}
	return env
}

func nativeTarget(goos, goarch string) error {
	if goos != runtime.GOOS || goarch != runtime.GOARCH {
		return fmt.Errorf("execution requires the native target %s/%s; selected context targets %s/%s (cross-target compile-only tools are not implemented)", runtime.GOOS, runtime.GOARCH, goos, goarch)
	}
	return nil
}
