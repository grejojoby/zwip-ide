#!/usr/bin/env python3
"""Prepare independent benchmark copies; never launch either IDE or edit source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

EXCLUDED = {'.git', '.worktrees', 'worktrees', 'node_modules', 'dist', 'target', '.next', '.cache', '.claude', 'coverage'}


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def copy_tree(source, destination):
    # copy2 copies bytes/metadata, not hard links. Internal dependency .bin symlinks
    # remain internal; external symlinks are rejected instead of aliasing user files.
    for directory, dirs, files in os.walk(source, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink() and not path.resolve().is_relative_to(source.resolve()):
                raise ValueError(f'External symlink prevents isolated copy: {path}')
    shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)
    for directory, dirs, files in os.walk(destination, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                link = Path(os.readlink(path))
                if link.is_absolute():
                    mapped = destination / link.resolve().relative_to(source.resolve())
                    path.unlink()
                    path.symlink_to(mapped)
                if not path.resolve().is_relative_to(destination.resolve()):
                    raise ValueError(f'Copied symlink escapes isolated directory: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, type=Path)
    parser.add_argument('--dependencies', required=True, type=Path, help='Dependency-complete copy with interfaces/{atlas,quizstudio}/frontend/node_modules')
    parser.add_argument('--intellij-config', type=Path)
    parser.add_argument('--out', type=Path, help='New empty output directory; defaults to a temporary directory')
    args = parser.parse_args()
    source = args.workspace.resolve(strict=True)
    dependency_root = args.dependencies.resolve(strict=True)
    paths = sorted({os.fsdecode(path) for path in subprocess.check_output(['git', '-C', str(source), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split(b'\0') if path})
    included = [path for path in paths if not any(part in EXCLUDED for part in Path(path).parts)]
    # Nested repositories/worktrees are not part of the top-level source graph.
    nested = set()
    for path in included:
        for parent in (source / path).parents:
            if parent == source:
                break
            if (parent / '.git').exists():
                nested.add(str(parent.relative_to(source)))
    included = [path for path in included if not any(Path(path).is_relative_to(prefix) for prefix in nested)]
    before = {}
    for relative in included:
        path = source / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Included source must be a regular file; review explicitly: {relative}')
        before[relative] = digest(path)
    destination = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix='zwip-native-benchmark-')).resolve()
    if args.out:
        destination.mkdir(parents=True, exist_ok=False)
    record = {'schemaVersion': 1, 'source': str(source), 'sourceRevision': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(), 'files': len(included), 'goModules': sum(Path(p).name == 'go.mod' for p in included), 'excludedComponents': sorted(EXCLUDED), 'excludedNestedRoots': sorted(nested), 'sourceHashes': before, 'copies': {}, 'dependencySource': str(dependency_root), 'intellijLaunched': False}
    try:
        for label in ['zwip', 'intellij']:
            target = destination / f'{label}-workspace'
            target.mkdir()
            for relative in included:
                original, copied = source / relative, target / relative
                copied.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, copied)
                if original.stat().st_ino == copied.stat().st_ino and original.stat().st_dev == copied.stat().st_dev:
                    raise ValueError(f'Unexpected hard link: {relative}')
                if digest(copied) != before[relative]:
                    raise ValueError(f'Copy verification failed: {relative}')
            dependencies = []
            for app in ['atlas', 'quizstudio']:
                relative = Path('interfaces') / app / 'frontend'
                for name in ['package.json', 'package-lock.json']:
                    if digest(target / relative / name) != digest(dependency_root / relative / name):
                        raise ValueError(f'Dependency manifest differs from copied source: {relative / name}')
                copy_tree(dependency_root / relative / 'node_modules', target / relative / 'node_modules')
                dependencies.append(str(relative / 'node_modules'))
            record['copies'][label] = {'root': str(target), 'sourceHashesMatch': True, 'copiedDependencyTrees': dependencies, 'gitMetadata': 'excluded; initialize a separate disposable repository for Git workloads'}
        if args.intellij_config:
            original = args.intellij_config.resolve(strict=True)
            profile = destination / 'intellij-profile'
            config = profile / 'config'
            config.mkdir(parents=True)
            # Preserve non-secret editing/analysis settings. Session history, licensing,
            # account tokens, consoles, scratch buffers and connection data are omitted.
            option_names = ['editor.xml', 'editor-font.xml', 'laf.xml', 'keymap.xml', 'ui.lnf.xml', 'colors.scheme.xml', 'codeStyleSettings.xml', 'breadcrumbs.xml', 'diff.xml', 'vcs.xml', 'git.xml', 'go.sdk.xml', 'javascript.xml', 'typescript.xml', 'debugger.xml', 'advancedSettings.xml']
            (config / 'options').mkdir()
            copied_options = []
            for name in option_names:
                if (original / 'options' / name).is_file():
                    shutil.copy2(original / 'options' / name, config / 'options' / name)
                    copied_options.append(name)
            for directory in ['codestyles', 'colors', 'keymaps']:
                if (original / directory).is_dir():
                    copy_tree(original / directory, config / directory)
            for name in ['disabled_plugins.txt', 'idea.vmoptions']:
                if (original / name).is_file():
                    shutil.copy2(original / name, config / name)
            application = ET.Element('application')
            settings = ET.SubElement(application, 'component', {'name': 'GeneralSettings'})
            ET.SubElement(settings, 'option', {'name': 'reopenLastProject', 'value': 'false'})
            ET.ElementTree(application).write(config / 'options' / 'ide.general.xml', encoding='UTF-8', xml_declaration=True)
            copy_tree(original / 'plugins', profile / 'plugins')
            properties = profile / 'idea.properties'
            properties.write_text('\n'.join(f'idea.{name}.path={profile / ("config" if name == "config" else "system" if name == "system" else "plugins" if name == "plugins" else "logs")}' for name in ['config', 'system', 'plugins', 'log']) + '\n')
            record['intellijProfile'] = {'root': str(profile), 'properties': str(properties), 'copiedOptions': copied_options, 'copiedPlugins': sorted(p.name for p in (profile / 'plugins').iterdir()), 'reopenLastProject': False, 'authenticationCopied': False, 'warning': 'Existing heap/plugin set and selected editor/analysis preferences retained; session/history/credential/license data omitted. Activation may require the user. This is an isolated profile, not all personal state.'}
        changed = [relative for relative, old in before.items() if not (source / relative).is_file() or digest(source / relative) != old]
        record['sourceUnchanged'] = not changed
        record['sourceChanges'] = changed
        record['prepared'] = not changed
        (destination / 'preparation.json').write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'directory': str(destination), 'prepared': record['prepared'], 'files': record['files'], 'goModules': record['goModules'], 'sourceUnchanged': record['sourceUnchanged'], 'copies': record['copies'], 'intellijProfile': record.get('intellijProfile')}, indent=2))
        if changed:
            raise ValueError('Source changed concurrently; do not use this benchmark snapshot')
    except Exception as error:
        record['prepared'] = False
        record['error'] = str(error)
        (destination / 'preparation.json').write_text(json.dumps(record, indent=2) + '\n')
        raise


if __name__ == '__main__':
    main()
