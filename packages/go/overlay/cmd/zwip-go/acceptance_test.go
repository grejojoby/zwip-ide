package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"golang.org/x/tools/gopls/internal/protocol"
)

type markedPosition struct {
	path     string
	position position
}

func markedSource(t *testing.T, root, name, source string, marks map[string]markedPosition) {
	t.Helper()
	pattern := regexp.MustCompile(`/\*@([a-z_]+)\*/`)
	offsets := map[string]int{}
	var text strings.Builder
	last := 0
	for _, match := range pattern.FindAllStringSubmatchIndex(source, -1) {
		text.WriteString(source[last:match[0]])
		offsets[source[match[2]:match[3]]] = text.Len()
		last = match[1]
	}
	text.WriteString(source[last:])
	path := put(t, root, name, text.String())
	mapper := protocol.NewMapper(protocol.URIFromPath(path), []byte(text.String()))
	for label, offset := range offsets {
		p, err := mapper.OffsetPosition(offset)
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := marks[label]; exists {
			t.Fatalf("duplicate marker %s", label)
		}
		marks[label] = markedPosition{path, p}
	}
}

// The oracle is the annotated source below, written before executing queries.
// Exact cases assert all physical declaration/use positions; hierarchy cases
// assert required method-set relations because alias spellings may coalesce.
func TestGoNavigationAcceptanceMatrix(t *testing.T) {
	root := t.TempDir()
	put(t, root, "app/go.mod", "module fixture/app\n\ngo 1.25\n")
	marks := map[string]markedPosition{}
	markedSource(t, root, "app/types.go", `package app
type /*@runner_decl*/Runner interface { /*@interface_method*/Run() int }
type /*@parent_decl*/Parent struct{}
func (Parent) /*@parent_method*/Run() int { return 1 }
type /*@child_decl*/Child struct{ /*@embedded_parent*/Parent }
type /*@alias_decl*/Alias = Parent
type Box[/*@type_parameter*/T any] struct{ /*@field_decl*/Value /*@type_parameter_use*/T }
func /*@generic_decl*/Identity[T any](value T) T { return value }
const /*@constant_decl*/Limit = 3
var /*@global_decl*/Global Parent
func /*@target_decl*/Target() int { return /*@constant_target_use*/Limit }
`, marks)
	markedSource(t, root, "app/usage.go", `package app
func /*@caller_decl*/Caller() int {
 a := /*@alias_use*/Alias{}
 c := /*@child_use*/Child{}
 b := /*@box_use*/Box[int]{/*@field_key*/Value: /*@constant_use*/Limit}
 _ = /*@generic_use*/Identity(b./*@field_use*/Value)
 _ = /*@global_use*/Global
 _ = /*@alias_value*/a
 _ = /*@child_value*/c
 var r /*@runner_use*/Runner = a
 _ = r./*@interface_call*/Run()
 _ = c./*@promoted_call*/Run()
 return /*@target_call*/Target()
}
func /*@shadow_decl*/Shadow() int {
 /*@local_decl*/Limit := 7
 return /*@local_use*/Limit
}
func /*@other_decl*/Other() int { return /*@other_call*/Target() }
func Constrained[T /*@runner_constraint*/Runner](value T) int { return value./*@constraint_call*/Run() }
`, marks)
	markedSource(t, root, "app/target_test.go", `package app
import "testing"
func /*@test_decl*/TestTarget(t *testing.T) { _ = /*@test_call*/Target() }
`, marks)
	w := startFixture(t, root, "app")
	type acceptanceCase struct {
		name, op, from string
		want           []string
		subset         bool
		relationship   string
	}
	cases := []acceptanceCase{
		{"01_function_definition", "definition", "target_call", []string{"target_decl"}, false, ""},
		{"02_function_references_include_tests", "references", "target_decl", []string{"target_call", "other_call", "test_call"}, false, ""},
		{"03_direct_incoming_calls", "incomingCalls", "target_decl", []string{"caller_decl", "other_decl", "test_decl"}, false, "static caller"},
		{"04_direct_outgoing_calls", "outgoingCalls", "other_decl", []string{"target_decl"}, false, "static callee"},
		{"05_alias_definition", "definition", "alias_use", []string{"alias_decl"}, false, ""},
		// Go 1.25 preserves alias identity. Upstream typeToObject explicitly
		// returns types.Alias.Obj: navigate to the declared alias spelling.
		{"06_alias_value_type", "typeDefinition", "alias_value", []string{"alias_decl"}, false, ""},
		{"07_type_parameter_definition", "definition", "type_parameter_use", []string{"type_parameter"}, false, ""},
		{"08_generic_function_definition", "definition", "generic_use", []string{"generic_decl"}, false, ""},
		{"09_generic_function_references", "references", "generic_decl", []string{"generic_use"}, false, ""},
		{"10_generic_field_definition", "definition", "field_use", []string{"field_decl"}, false, ""},
		{"11_keyed_field_definition", "definition", "field_key", []string{"field_decl"}, false, ""},
		{"12_generic_field_references", "references", "field_decl", []string{"field_use", "field_key"}, false, ""},
		{"13_global_definition", "definition", "global_use", []string{"global_decl"}, false, ""},
		{"14_global_type_definition", "typeDefinition", "global_use", []string{"parent_decl"}, false, ""},
		{"15_global_references", "references", "global_decl", []string{"global_use"}, false, ""},
		{"16_constant_definition", "definition", "constant_use", []string{"constant_decl"}, false, ""},
		{"17_constant_references_exclude_shadow", "references", "constant_decl", []string{"constant_use", "constant_target_use"}, false, ""},
		{"18_shadow_definition", "definition", "local_use", []string{"local_decl"}, false, ""},
		{"19_shadow_references", "references", "local_decl", []string{"local_use"}, false, ""},
		{"20_embedded_type_definition", "definition", "embedded_parent", []string{"parent_decl"}, false, ""},
		{"21_promoted_method_definition", "definition", "promoted_call", []string{"parent_method"}, false, ""},
		{"22_interface_method_definition", "definition", "interface_call", []string{"interface_method"}, false, ""},
		{"23_interface_type_definition", "definition", "runner_use", []string{"runner_decl"}, false, ""},
		{"24_constraint_method_definition", "definition", "constraint_call", []string{"interface_method"}, false, ""},
		{"25_interface_type_references", "references", "runner_decl", []string{"runner_use", "runner_constraint"}, false, ""},
		{"26_embedded_value_type", "typeDefinition", "child_value", []string{"child_decl"}, false, ""},
		{"27_implicit_implementations", "implementations", "runner_decl", []string{"parent_decl", "child_decl"}, true, "method-set candidate"},
		{"28_alias_references", "references", "alias_decl", []string{"alias_use"}, false, ""},
		{"29_method_set_subtypes", "typeHierarchy", "runner_decl", []string{"parent_decl", "child_decl"}, true, "method-set subtype"},
		{"30_method_set_supertypes", "typeHierarchy", "parent_decl", []string{"runner_decl"}, true, "method-set supertype"},
	}
	if len(cases) != 30 {
		t.Fatal("acceptance matrix must contain 30 named cases")
	}
	key := func(path string, p position) string { return fmt.Sprintf("%s:%d:%d", path, p.Line, p.Character) }
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			source := marks[test.from]
			result := w.query(context.Background(), navigationQuery{ID: test.name, Operation: test.op, Path: source.path, Position: source.position, WorkspaceGeneration: 1})
			if result.State != "complete" {
				t.Fatalf("%+v", result)
			}
			actual := map[string]bool{}
			for _, location := range result.Locations {
				if test.relationship != "" && location.Relationship != test.relationship {
					continue
				}
				actual[key(location.Path, location.Range.Start)] = true
			}
			for _, label := range test.want {
				want := marks[label]
				if !actual[key(want.path, want.position)] {
					t.Errorf("missing source-adjudicated %s: %+v", label, result)
				}
			}
			if !test.subset && len(actual) != len(test.want) {
				t.Errorf("unexpected source locations: want %v got %+v", test.want, result)
			}
		})
	}
}
