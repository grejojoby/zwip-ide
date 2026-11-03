use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct OpenTarget {
    pub root: String,
    pub file: Option<String>,
}

impl OpenTarget {
    pub fn from_path(path: &Path) -> Result<Self, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let (root, file) = if path.is_dir() {
            (path.as_path(), None)
        } else if path.is_file() {
            (
                path.parent().ok_or("File has no parent directory")?,
                Some(
                    path.to_str()
                        .ok_or("File path is not valid UTF-8")?
                        .to_owned(),
                ),
            )
        } else {
            return Err("Choose a regular file or directory".into());
        };
        Ok(Self {
            root: root
                .to_str()
                .ok_or("Directory path is not valid UTF-8")?
                .to_owned(),
            file,
        })
    }
}

const MARKER: &str = "#!/bin/sh\n# Zwip command-line launcher\n";

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn launcher(app: &Path) -> Result<String, String> {
    let app = shell_quote(app.to_str().ok_or("Application path is not valid UTF-8")?);
    Ok(format!(
        r#"{MARKER}case "${{1-}}" in
  -h|--help) printf '%s\n' 'Usage: zwip [directory|file]' 'With no path, opens the current directory.'; exit 0 ;;
  --) shift ;;
esac
if [ "$#" -gt 1 ]; then
  printf '%s\n' 'Usage: zwip [directory|file]' >&2
  exit 2
fi
target=${{1-.}}
case "$target" in
  /*) ;;
  *) target="$PWD/$target" ;;
esac
if [ ! -d "$target" ] && [ ! -f "$target" ]; then
  printf 'zwip: no file or directory: %s\n' "$target" >&2
  exit 1
fi
exec /usr/bin/open -a {app} -- "$target"
"#
    ))
}

fn app_bundle(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then(|| app.to_path_buf())
}

#[derive(Serialize)]
pub(crate) struct CommandLineStatus {
    path: String,
    installed: bool,
    unavailable: Option<String>,
}

fn installation() -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = std::env::var_os("HOME").ok_or("Home directory is unavailable")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok((
        PathBuf::from(home).join(".local/bin/zwip"),
        app_bundle(&executable),
    ))
}

fn is_installed(path: &Path, expected: &str) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    std::fs::read_to_string(path).is_ok_and(|contents| contents == expected)
}

#[tauri::command]
pub(crate) fn command_line_status() -> Result<CommandLineStatus, String> {
    let (path, app) = installation()?;
    let expected = app.as_deref().map(launcher).transpose()?;
    Ok(CommandLineStatus {
        installed: expected.is_some_and(|expected| is_installed(&path, &expected)),
        path: path.to_string_lossy().into_owned(),
        unavailable: if !cfg!(target_os = "macos") {
            Some("The command-line launcher currently supports macOS only.".into())
        } else if app.is_none() {
            Some("Open a built Zwip.app to install the command-line tool. Development executables are not supported.".into())
        } else {
            None
        },
    })
}

fn install(path: &Path, app: &Path) -> Result<(), String> {
    let script = launcher(app)?;
    let existing = match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || !std::fs::read_to_string(path)
                    .map_err(|e| e.to_string())?
                    .starts_with(MARKER)
            {
                return Err(format!(
                    "A different command already exists at {}. Move it before installing Zwip.",
                    path.display()
                ));
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.to_string()),
    };
    let directory = path
        .parent()
        .ok_or("Installation directory is unavailable")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    use std::io::Write;
    temporary
        .write_all(script.as_bytes())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    if existing {
        temporary.persist(path).map_err(|e| e.to_string())?;
    } else {
        temporary
            .persist_noclobber(path)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn install_command_line_tool() -> Result<CommandLineStatus, String> {
    let (path, app) = installation()?;
    if !cfg!(target_os = "macos") {
        return Err("The command-line launcher currently supports macOS only.".into());
    }
    install(
        &path,
        &app.ok_or("Open a built Zwip.app to install the command-line tool.")?,
    )?;
    command_line_status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    #[test]
    fn resolves_directories_files_symlinks_and_missing_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let file = root.join("a file é.txt");
        fs::write(&file, "hello").unwrap();
        assert_eq!(
            OpenTarget::from_path(&root).unwrap(),
            OpenTarget {
                root: root.to_str().unwrap().into(),
                file: None
            }
        );
        assert_eq!(
            OpenTarget::from_path(&file).unwrap().file,
            Some(file.to_str().unwrap().into())
        );
        assert!(OpenTarget::from_path(&root.join("missing")).is_err());
        #[cfg(unix)]
        {
            let link = root.join("link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert_eq!(OpenTarget::from_path(&link), OpenTarget::from_path(&file));
        }
    }

    #[test]
    fn installs_executable_updates_own_launcher_and_preserves_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bin/zwip");
        install(&path, Path::new("/Applications/Zwip.app")).unwrap();
        assert!(Command::new(&path)
            .arg("--help")
            .output()
            .unwrap()
            .status
            .success());
        install(&path, Path::new("/Applications/Moved Zwip.app")).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("Moved Zwip.app"));
        fs::write(&path, "another tool").unwrap();
        assert!(install(&path, Path::new("/Applications/Zwip.app")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "another tool");
        #[cfg(unix)]
        {
            fs::remove_file(&path).unwrap();
            let other = temp.path().join("other");
            fs::write(&other, MARKER).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            assert!(install(&path, Path::new("/Applications/Zwip.app")).is_err());
            assert_eq!(fs::read_to_string(other).unwrap(), MARKER);
        }
    }

    #[test]
    fn launcher_quotes_app_paths_and_rejects_missing_or_multiple_targets() {
        let script = launcher(Path::new("/Apps/It's $(unsafe) Zwip.app")).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("zwip");
        fs::write(&path, &script).unwrap();
        assert!(Command::new("/bin/sh")
            .args(["-n"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(script.contains("'/Apps/It'\\''s $(unsafe) Zwip.app'"));
        assert!(!Command::new("/bin/sh")
            .arg(&path)
            .arg(temp.path().join("missing"))
            .output()
            .unwrap()
            .status
            .success());
        assert_eq!(
            Command::new("/bin/sh")
                .arg(&path)
                .args(["a", "b"])
                .output()
                .unwrap()
                .status
                .code(),
            Some(2)
        );
        assert!(app_bundle(Path::new("/Apps/Zwip.app/Contents/MacOS/zwip")).is_some());
        assert!(app_bundle(Path::new("/target/debug/zwip")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn launcher_forwards_relative_absolute_and_default_paths_without_shell_expansion() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let capture = root.join("capture");
        let opener = root.join("open");
        fs::write(
            &opener,
            "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$ZWIP_CAPTURE\"\n",
        )
        .unwrap();
        fs::set_permissions(&opener, fs::Permissions::from_mode(0o755)).unwrap();
        let app = "/Apps/It's $(unsafe) Zwip.app";
        let script = launcher(Path::new(app)).unwrap().replace(
            "exec /usr/bin/open",
            &format!("exec {}", shell_quote(opener.to_str().unwrap())),
        );
        let path = root.join("zwip");
        fs::write(&path, script).unwrap();
        let name = "a file é ' $(touch injected).txt";
        fs::write(root.join(name), "hello").unwrap();
        for args in [
            vec![],
            vec![name.to_owned()],
            vec![root.join(name).to_str().unwrap().to_owned()],
        ] {
            assert!(Command::new("/bin/sh")
                .arg(&path)
                .args(&args)
                .current_dir(&root)
                .env("ZWIP_CAPTURE", &capture)
                .status()
                .unwrap()
                .success());
            let output = fs::read_to_string(&capture).unwrap();
            let parts: Vec<_> = output.split('\0').collect();
            assert_eq!(&parts[..3], &["-a", app, "--"]);
            assert_eq!(
                parts[3],
                if args.is_empty() {
                    root.join(".")
                } else {
                    root.join(name)
                }
                .to_str()
                .unwrap()
            );
        }
        assert!(!root.join("injected").exists());
    }
}
