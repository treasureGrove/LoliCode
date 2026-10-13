use crate::{
    credentials::Credentials,
    error::{Result, SafeError},
};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::Zeroizing;

const LOCAL_TOKEN: &str = "local-gateway-token";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    pub enabled: bool,
    pub confirmed_free: bool,
    pub key_present: bool,
}
impl Channel {
    pub fn public_model(&self) -> String {
        format!("{}/{}", self.id, self.model)
    }
    pub(crate) fn credential_id(&self) -> String {
        format!("channel:{}", self.id)
    }
}

// Deliberately not Debug/Serialize: this command input contains an upstream secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveChannel {
    pub id: Option<String>,
    pub name: String,
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    pub enabled: bool,
    pub confirmed_free: bool,
    pub api_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub id: i64,
    pub timestamp: i64,
    pub channel_id: String,
    pub model: String,
    pub status: u16,
    pub duration_ms: u64,
    pub result: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub gross_cost_usd: Option<String>,
    pub free_discount_usd: Option<String>,
    pub billable_cost_usd: Option<String>,
    pub billing_status: String,
    pub is_streaming: bool,
}

pub struct Store {
    pub(crate) db: Mutex<Connection>,
    credentials: Arc<dyn Credentials>,
    pub(crate) updates: Mutex<()>,
    pub(crate) billing_fault: AtomicBool,
}

impl Store {
    pub fn open(dir: &Path, credentials: Arc<dyn Credentials>) -> Result<Arc<Self>> {
        std::fs::create_dir_all(dir).map_err(|_| SafeError::storage())?;
        let db = Connection::open(dir.join("freehub.db")).map_err(|_| SafeError::storage())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
          CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY,name TEXT NOT NULL,provider_id TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL,enabled INTEGER NOT NULL,confirmed_free INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY,timestamp INTEGER NOT NULL,channel_id TEXT NOT NULL,model TEXT NOT NULL,status INTEGER NOT NULL,duration_ms INTEGER NOT NULL,result TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS channel_models (channel_id TEXT PRIMARY KEY,models TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS model_settings (channel_id TEXT NOT NULL,model TEXT NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(channel_id,model));
          CREATE TABLE IF NOT EXISTS quota_ledger (channel_id TEXT NOT NULL,model TEXT NOT NULL,revision INTEGER NOT NULL,period TEXT NOT NULL,used TEXT NOT NULL,PRIMARY KEY(channel_id,model,revision,period));")
            .map_err(|_| SafeError::storage())?;
        let columns: Vec<String> = db
            .prepare("PRAGMA table_info(requests)")
            .map_err(|_| SafeError::storage())?
            .query_map([], |r| r.get(1))
            .map_err(|_| SafeError::storage())?
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| SafeError::storage())?;
        for (name, definition) in [
            ("input_tokens", "INTEGER"),
            ("output_tokens", "INTEGER"),
            ("cache_read_tokens", "INTEGER"),
            ("cache_creation_tokens", "INTEGER"),
            ("gross_cost_usd", "TEXT"),
            ("free_discount_usd", "TEXT"),
            ("billable_cost_usd", "TEXT"),
            ("billing_status", "TEXT NOT NULL DEFAULT 'legacy'"),
            ("is_streaming", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !columns.iter().any(|c| c == name) {
                db.execute_batch(&format!(
                    "ALTER TABLE requests ADD COLUMN {name} {definition}"
                ))
                .map_err(|_| SafeError::storage())?;
            }
        }
        // Only the original single model had a user-confirmed free policy.
        // Seed it once; newly added models always start metered with unknown prices.
        let legacy: Vec<(String,String)> = db.prepare("SELECT id,model FROM channels WHERE confirmed_free=1 AND NOT EXISTS (SELECT 1 FROM channel_models WHERE channel_id=channels.id)").map_err(|_|SafeError::storage())?.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|SafeError::storage())?.collect::<std::result::Result<_,_>>().map_err(|_|SafeError::storage())?;
        for (id, model) in legacy {
            let config = serde_json::json!({"model":model,"billingMode":"free","inputCostPerMillion":null,"outputCostPerMillion":null,"cacheReadCostPerMillion":null,"cacheCreationCostPerMillion":null,"quotaType":"tokens","quotaTotal":"0","quotaPeriod":"once"});
            db.execute(
                "INSERT OR IGNORE INTO model_settings VALUES (?1,?2,?3,0)",
                params![id, model, config.to_string()],
            )
            .map_err(|_| SafeError::storage())?;
        }
        let store = Arc::new(Self {
            db: Mutex::new(db),
            credentials,
            updates: Mutex::new(()),
            billing_fault: AtomicBool::new(false),
        });
        store.ensure_token()?;
        Ok(store)
    }

    fn ensure_token(&self) -> Result<()> {
        if let Some(token) = self.credentials.get(LOCAL_TOKEN)? {
            self.write_token_digest(&token)?;
        } else {
            self.rotate_token()?;
        }
        Ok(())
    }
    fn write_token_digest(&self, token: &str) -> Result<()> {
        let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        self.db
            .lock()
            .map_err(|_| SafeError::storage())?
            .execute(
                "INSERT OR REPLACE INTO settings VALUES ('token_digest',?1)",
                [hash],
            )
            .map_err(|_| SafeError::storage())?;
        Ok(())
    }
    pub fn rotate_token(&self) -> Result<()> {
        let _update = self.updates.lock().map_err(|_| SafeError::storage())?;
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = Zeroizing::new(format!(
            "sk-tai-switch-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        let old = self.credentials.get(LOCAL_TOKEN)?;
        self.credentials.set(LOCAL_TOKEN, &token)?;
        if let Err(err) = self.write_token_digest(&token) {
            if let Some(old) = old {
                self.credentials.set(LOCAL_TOKEN, &old)?;
            } else {
                self.credentials.delete(LOCAL_TOKEN)?;
            }
            return Err(err);
        }
        Ok(())
    }
    pub fn local_token(&self) -> Result<Zeroizing<String>> {
        self.credentials
            .get(LOCAL_TOKEN)?
            .ok_or_else(SafeError::credentials)
    }
    pub fn authenticate(&self, token: &str) -> bool {
        let Ok(db) = self.db.lock() else { return false };
        let expected: String = db
            .query_row(
                "SELECT value FROM settings WHERE name='token_digest'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        let actual = format!("{:x}", Sha256::digest(token.as_bytes()));
        expected.as_bytes().ct_eq(actual.as_bytes()).into()
    }

    pub fn channels(&self) -> Result<Vec<Channel>> {
        let rows = {
            let db = self.db.lock().map_err(|_| SafeError::storage())?;
            let mut query = db.prepare("SELECT c.id,c.name,c.provider_id,c.base_url,c.model,c.enabled,c.confirmed_free,m.models FROM channels c LEFT JOIN channel_models m ON m.channel_id=c.id ORDER BY c.rowid").map_err(|_| SafeError::storage())?;
            let result = query
                .query_map([], |r| {
                    Ok(Channel {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        provider_id: r.get(2)?,
                        base_url: r.get(3)?,
                        model: r.get(4)?,
                        models: r
                            .get::<_, Option<String>>(7)?
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or_else(|| vec![r.get::<_, String>(4).unwrap_or_default()]),
                        enabled: r.get(5)?,
                        confirmed_free: r.get(6)?,
                        key_present: false,
                    })
                })
                .map_err(|_| SafeError::storage())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| SafeError::storage())?;
            result
        };
        rows.into_iter()
            .map(|mut c| {
                c.key_present = self.credentials.get(&c.credential_id())?.is_some();
                Ok(c)
            })
            .collect()
    }

    pub fn save_channel(&self, input: SaveChannel) -> Result<Channel> {
        let _update = self.updates.lock().map_err(|_| SafeError::storage())?;
        let url = Url::parse(input.base_url.trim())
            .map_err(|_| SafeError::invalid("请输入有效的 HTTPS 接口地址。"))?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(SafeError::invalid(
                "接口地址必须是 HTTPS，且不能包含账户、密码、查询参数或片段。",
            ));
        }
        if input.name.trim().is_empty()
            || input.name.len() > 120
            || input.model.trim().is_empty()
            || input.model.len() > 200
            || input.model.chars().any(char::is_control)
            || !input
                .provider_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            || input.provider_id.is_empty()
            || input.provider_id.len() > 80
        {
            return Err(SafeError::invalid("请填写有效的渠道名称和模型 ID。"));
        }
        let models = if input.models.is_empty() {
            vec![input.model.trim().to_string()]
        } else {
            input
                .models
                .into_iter()
                .map(|m| m.trim().to_string())
                .collect()
        };
        let mut unique = std::collections::HashSet::new();
        if models.len() > 200
            || models.iter().any(|m| {
                m.is_empty()
                    || m.len() > 200
                    || m.chars().any(char::is_control)
                    || !unique.insert(m)
            })
        {
            return Err(SafeError::invalid("请填写最多 200 个不重复的有效模型 ID。"));
        }
        let id = if let Some(id) = input.id {
            if !self.channels()?.iter().any(|c| c.id == id) {
                return Err(SafeError::invalid("渠道不存在，请刷新后重试。"));
            }
            id
        } else {
            format!(
                "{}-{}",
                input.provider_id,
                &uuid::Uuid::new_v4().to_string()[..8]
            )
        };
        let c = Channel {
            id,
            name: input.name.trim().into(),
            provider_id: input.provider_id,
            base_url: url.to_string().trim_end_matches('/').into(),
            model: models[0].clone(),
            models,
            enabled: input.enabled,
            confirmed_free: input.confirmed_free,
            key_present: true,
        };
        let key_id = c.credential_id();
        let old_key = self.credentials.get(&key_id)?;
        let new_key = input
            .api_key
            .map(Zeroizing::new)
            .filter(|k| !k.trim().is_empty());
        if let Some(key) = &new_key {
            if key.len() > 4096 || key.chars().any(char::is_control) || key.trim() != key.as_str() {
                return Err(SafeError::invalid("Key 包含空格或无效字符，请重新粘贴。"));
            }
            self.credentials.set(&key_id, key)?;
        } else if old_key.is_none() {
            return Err(SafeError::invalid("请填写渠道 API Key。"));
        }
        let written = (|| -> Result<()> {
            let mut db = self.db.lock().map_err(|_| SafeError::storage())?;
            let tx = db.transaction().map_err(|_| SafeError::storage())?;
            tx.execute("INSERT INTO channels VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider_id=excluded.provider_id,base_url=excluded.base_url,model=excluded.model,enabled=excluded.enabled,confirmed_free=excluded.confirmed_free",params![c.id,c.name,c.provider_id,c.base_url,c.model,c.enabled,c.confirmed_free]).map_err(|_|SafeError::storage())?;
            tx.execute(
                "INSERT OR REPLACE INTO channel_models VALUES (?1,?2)",
                params![
                    c.id,
                    serde_json::to_string(&c.models).map_err(|_| SafeError::storage())?
                ],
            )
            .map_err(|_| SafeError::storage())?;
            tx.commit().map_err(|_| SafeError::storage())
        })();
        if written.is_err() {
            if new_key.is_some() {
                if let Some(old) = old_key {
                    self.credentials.set(&key_id, &old)?;
                } else {
                    self.credentials.delete(&key_id)?;
                }
            }
            return Err(SafeError::storage());
        }
        Ok(c)
    }

    pub fn delete_channel(&self, id: &str) -> Result<()> {
        let _update = self.updates.lock().map_err(|_| SafeError::storage())?;
        let channel = self
            .channels()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| SafeError::invalid("渠道不存在。"))?;
        let old = self.credentials.get(&channel.credential_id())?;
        self.credentials.delete(&channel.credential_id())?;
        let deleted = (|| -> Result<()> {
            let mut db = self.db.lock().map_err(|_| SafeError::storage())?;
            let tx = db.transaction().map_err(|_| SafeError::storage())?;
            tx.execute("DELETE FROM channels WHERE id=?1", [id])
                .map_err(|_| SafeError::storage())?;
            tx.execute("DELETE FROM channel_models WHERE channel_id=?1", [id])
                .map_err(|_| SafeError::storage())?;
            tx.execute("DELETE FROM model_settings WHERE channel_id=?1", [id])
                .map_err(|_| SafeError::storage())?;
            tx.commit().map_err(|_| SafeError::storage())
        })();
        if deleted.is_err() {
            if let Some(old) = old {
                self.credentials.set(&channel.credential_id(), &old)?;
            }
            return Err(SafeError::storage());
        }
        Ok(())
    }
    pub(crate) fn key(&self, c: &Channel) -> Result<Zeroizing<String>> {
        self.credentials
            .get(&c.credential_id())?
            .ok_or_else(SafeError::credentials)
    }
    pub fn logs(&self) -> Result<Vec<RequestLog>> {
        let db = self.db.lock().map_err(|_| SafeError::storage())?;
        let mut q = db.prepare("SELECT timestamp,channel_id,model,status,duration_ms,result,id,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,gross_cost_usd,free_discount_usd,billable_cost_usd,billing_status,is_streaming FROM requests ORDER BY id DESC LIMIT 100").map_err(|_| SafeError::storage())?;
        let result = q
            .query_map([], |r| {
                Ok(RequestLog {
                    timestamp: r.get(0)?,
                    channel_id: r.get(1)?,
                    model: r.get(2)?,
                    status: r.get(3)?,
                    duration_ms: r.get(4)?,
                    result: r.get(5)?,
                    id: r.get(6)?,
                    input_tokens: r.get(7)?,
                    output_tokens: r.get(8)?,
                    cache_read_tokens: r.get(9)?,
                    cache_creation_tokens: r.get(10)?,
                    gross_cost_usd: r.get(11)?,
                    free_discount_usd: r.get(12)?,
                    billable_cost_usd: r.get(13)?,
                    billing_status: r.get(14)?,
                    is_streaming: r.get(15)?,
                })
            })
            .map_err(|_| SafeError::storage())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| SafeError::storage())?;
        Ok(result)
    }
    #[cfg(test)]
    pub(crate) fn test_channel(&self, base_url: String, key: &str) -> Channel {
        let c = self
            .save_channel(SaveChannel {
                id: None,
                name: "test".into(),
                provider_id: "test".into(),
                base_url: "https://example.com/v1".into(),
                model: "test-model".into(),
                models: vec![],
                enabled: true,
                confirmed_free: true,
                api_key: Some(key.into()),
            })
            .unwrap();
        self.db
            .lock()
            .unwrap()
            .execute(
                "UPDATE channels SET base_url=?1 WHERE id=?2",
                params![base_url, c.id],
            )
            .unwrap();
        self.channels()
            .unwrap()
            .into_iter()
            .find(|x| x.id == c.id)
            .unwrap()
    }
}
