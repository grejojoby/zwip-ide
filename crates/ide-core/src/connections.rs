use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
const SERVICE: &str = "dev.zwip.ide.connections";
pub struct Connections {
    db: Connection,
}
pub struct ImportConnection {
    pub identity: String,
    pub connection: Value,
}

pub(crate) fn endpoint(value: &Value) -> String {
    let config = &value["config"];
    let kind = value["kind"].as_str().unwrap_or_default();
    json!({"kind":kind,"host":config["host"].as_str().unwrap_or_default().to_ascii_lowercase(),
        "port":config["port"].as_u64().unwrap_or(match kind {"mysql"=>3306,"postgres"=>5432,"mssql"=>1433,"redis"=>6379,_=>0}),
        "database":config["database"].as_str().unwrap_or_default(),"username":config["username"].as_str().unwrap_or_default(),
        "path":config["path"].as_str().unwrap_or_default(),"tls":config["tls"].as_bool().unwrap_or(false),"trustServerCertificate":config["trustServerCertificate"].as_bool().unwrap_or(false)}).to_string()
}

fn duplicate(db: &Connection, item: &ImportConnection) -> Result<bool, String> {
    let found: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM connection_imports WHERE identity=?1) OR EXISTS(SELECT 1 FROM connections WHERE id=?2)",params![item.identity,item.connection["id"].as_str().unwrap_or_default()],|row|row.get(0)).map_err(|_|"Cannot check existing connections")?;
    if found {
        return Ok(true);
    }
    let mut statement = db
        .prepare("SELECT kind,config FROM connections")
        .map_err(|_| "Cannot check existing connections")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot check existing connections")?;
    let expected = endpoint(&item.connection);
    for row in rows {
        let (kind, config) = row.map_err(|_| "Cannot check existing connections")?;
        let config: Value = serde_json::from_str(&config)
            .map_err(|_| "Stored connection configuration is invalid")?;
        if endpoint(&json!({"kind":kind,"config":config})) == expected {
            return Ok(true);
        }
    }
    Ok(false)
}
impl Connections {
    pub fn new(data: &Path) -> Result<Self, String> {
        let db = Connection::open(data.join("connections.sqlite")).map_err(|e| e.to_string())?;
        // Each IDE window has its own core and connection to this shared store.
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL)").map_err(|e|e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS connection_imports(identity TEXT PRIMARY KEY,connection_id TEXT NOT NULL UNIQUE)").map_err(|_|"Cannot initialize connection import metadata")?;
        Ok(Self { db })
    }
    pub fn list(&self) -> Result<Value, String> {
        let mut statement = self
            .db
            .prepare("SELECT id,kind,name,config FROM connections ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows=statement.query_map([],|row|Ok(json!({"id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,"name":row.get::<_,String>(2)?,"config":serde_json::from_str::<Value>(&row.get::<_,String>(3)?).unwrap_or(Value::Null)}))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(Value::from)
            .map_err(|e| e.to_string())
    }
    pub fn import_duplicate(&self, item: &ImportConnection) -> Result<bool, String> {
        duplicate(&self.db, item)
    }
    /// Import only parser-produced metadata. This path never reads or writes Keychain secrets.
    pub fn import_batch(&mut self, items: &[ImportConnection]) -> Result<Value, String> {
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin connection import")?;
        let mut identities = std::collections::HashSet::new();
        let mut endpoints = std::collections::HashSet::new();
        for item in items {
            if !identities.insert(&item.identity)
                || !endpoints.insert(endpoint(&item.connection))
                || duplicate(&transaction, item)?
            {
                return Err(
                    "A selected connection already exists; preview the source again".into(),
                );
            }
        }
        for item in items {
            let value = &item.connection;
            transaction
                .execute(
                    "INSERT INTO connections(id,kind,name,config) VALUES(?1,?2,?3,?4)",
                    params![
                        value["id"].as_str(),
                        value["kind"].as_str(),
                        value["name"].as_str(),
                        value["config"].to_string()
                    ],
                )
                .map_err(|_| "Cannot import connections; no changes were saved")?;
            transaction
                .execute(
                    "INSERT INTO connection_imports(identity,connection_id) VALUES(?1,?2)",
                    params![item.identity, value["id"].as_str()],
                )
                .map_err(|_| "Cannot record connection import; no changes were saved")?;
        }
        transaction
            .commit()
            .map_err(|_| "Cannot finish connection import")?;
        Ok(json!({"imported":items.len(),"connections":self.list()?}))
    }
    pub fn save(&self, params: &Value) -> Result<Value, String> {
        let id = crate::string(params, "id")?;
        let kind = crate::string(params, "kind")?;
        let name = crate::string(params, "name")?;
        if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err("Invalid connection id".into());
        }
        if !matches!(kind, "mysql" | "postgres" | "sqlite" | "mssql" | "redis") {
            return Err("Unsupported connection kind".into());
        }
        let mut config = params["config"]
            .as_object()
            .ok_or("Missing connection configuration")?
            .clone();
        // Persist only connection fields. Credentials use the system Keychain.
        let fields = [
            "host",
            "port",
            "database",
            "username",
            "path",
            "tls",
            "trustServerCertificate",
        ];
        config.retain(|key, _| fields.contains(&key.as_str()));
        if let Some(password) = params["password"].as_str() {
            set_secret(id, password)?;
        }
        self.db.execute("INSERT INTO connections(id,kind,name,config) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,config=excluded.config",params![id,kind,name,Value::Object(config).to_string()]).map_err(|e|e.to_string())?;
        self.list()
    }
    pub fn resolved(&self, id: &str) -> Result<Value, String> {
        let (kind, config): (String, String) = self
            .db
            .query_row(
                "SELECT kind,config FROM connections WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Connection not found".to_string())?;
        let mut config: Value = serde_json::from_str(&config).map_err(|e| e.to_string())?;
        config["kind"] = json!(kind);
        config["id"] = json!(id);
        if let Some(password) = secret(id)? {
            config["password"] = json!(password);
        }
        Ok(config)
    }
    pub fn delete(&self, id: &str) -> Result<Value, String> {
        delete_secret(id)?;
        self.db
            .execute("DELETE FROM connections WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        self.db
            .execute(
                "DELETE FROM connection_imports WHERE connection_id=?1",
                [id],
            )
            .map_err(|_| "Cannot remove connection import metadata")?;
        self.list()
    }
}
#[cfg(target_os = "macos")]
fn set_secret(id: &str, value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, id, value.as_bytes())
        .map_err(|_| "Cannot save credential to macOS Keychain".into())
}
#[cfg(target_os = "macos")]
fn secret(id: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, id) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "Credential is not UTF-8".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("Cannot read credential from macOS Keychain".into()),
    }
}
#[cfg(target_os = "macos")]
fn delete_secret(id: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, id) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("Cannot remove credential from macOS Keychain".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn set_secret(_id: &str, _value: &str) -> Result<(), String> {
    Err("Credential storage is currently supported on macOS only".into())
}
#[cfg(not(target_os = "macos"))]
fn secret(_id: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "macos"))]
fn delete_secret(_id: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_server_metadata_round_trips_without_persisting_credentials() {
        let data = tempfile::tempdir().unwrap();
        let store = Connections::new(data.path()).unwrap();
        let result = store
            .save(
                &json!({"id":"mssql-test", "kind":"mssql", "name":"SQL Server",
            "config":{"host":"localhost","port":1433,"database":"demo","username":"reader",
                "tls":true,"trustServerCertificate":true,"password":"must-not-persist"}}),
            )
            .unwrap();
        assert_eq!(result[0]["kind"], "mssql");
        assert_eq!(result[0]["config"]["trustServerCertificate"], true);
        assert!(result[0]["config"].get("password").is_none());
        assert_eq!(
            Connections::new(data.path()).unwrap().list().unwrap(),
            result
        );
        assert_eq!(
            endpoint(&json!({"kind":"mssql","config":{}})),
            endpoint(&json!({"kind":"mssql","config":{"port":1433}}))
        );
    }
}
