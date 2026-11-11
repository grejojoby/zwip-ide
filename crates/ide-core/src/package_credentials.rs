use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
const SERVICE: &str = "dev.zwip.ide.package-credentials";

fn account(package: &str, workspace: &str, id: &str) -> Result<String, String> {
    for value in [package, id] {
        if value.is_empty()
            || value.len() > 80
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("Invalid package credential identity".into());
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{package}\0{workspace}\0{id}").as_bytes())
    ))
}
pub fn set(package: &str, workspace: &str, id: &str, value: &str) -> Result<(), String> {
    let account = account(package, workspace, id)?;
    if value.len() > 16384 {
        return Err("Credential exceeds its size limit".into());
    }
    save(&account, value)
}
pub fn get(package: &str, workspace: &str, id: &str) -> Result<Option<String>, String> {
    load(&account(package, workspace, id)?)
}
pub fn delete(package: &str, workspace: &str, id: &str) -> Result<(), String> {
    remove(&account(package, workspace, id)?)
}
#[cfg(target_os = "macos")]
fn save(account: &str, value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, account, value.as_bytes())
        .map_err(|_| "Cannot save package credential to macOS Keychain".into())
}
#[cfg(target_os = "macos")]
fn load(account: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, account) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "Package credential is not UTF-8".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("Cannot read package credential from macOS Keychain".into()),
    }
}
#[cfg(target_os = "macos")]
fn remove(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("Cannot remove package credential from macOS Keychain".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn save(_account: &str, _value: &str) -> Result<(), String> {
    Err(
        "Saved package credentials require macOS Keychain; use session credentials or an SSH agent"
            .into(),
    )
}
#[cfg(not(target_os = "macos"))]
fn load(_account: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "macos"))]
fn remove(_account: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_credentials_are_scoped_to_package_workspace_and_identity() {
        let first = account("deployment", "/workspace/one", "credential-id").unwrap();
        assert_ne!(
            first,
            account("other", "/workspace/one", "credential-id").unwrap()
        );
        assert_ne!(
            first,
            account("deployment", "/workspace/two", "credential-id").unwrap()
        );
        assert_ne!(
            first,
            account("deployment", "/workspace/one", "other-id").unwrap()
        );
        assert!(account("../deployment", "/workspace/one", "id").is_err());
        assert!(account("deployment", "/workspace/one", "bad\0id").is_err());
    }
}
