//! Local identities for remote projects. An anchor contains no project source.
//! Model credentials and sessions stay local; only bounded tool RPC goes remote.
use super::{
    agent_preferences::path_key,
    remote_transport::{self, RemoteTarget},
};
use crate::database::Database;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

const KEY: &str = "lolicode_remote_projects_v1";
const MAX_STORE: usize = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteConnection {
    pub id: String,
    pub name: String,
    pub target: RemoteTarget,
    pub enabled: bool,
    pub revision: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProject {
    pub id: String,
    pub connection_id: String,
    pub target_fingerprint: String,
    pub root: String,
    pub name: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    connections: BTreeMap<String, RemoteConnection>,
    projects: BTreeMap<String, RemoteProject>,
}
#[derive(Default)]
struct Gate {
    flights: BTreeMap<String, (String, watch::Sender<bool>)>,
}
pub struct RemoteProjects {
    db: Arc<Database>,
    anchors: PathBuf,
    gate: Mutex<Gate>,
}
pub struct ResolvedProject {
    pub project: RemoteProject,
    pub connection: RemoteConnection,
}

fn fingerprint(target: &RemoteTarget) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(target).map_err(|_| "远程目标编码失败")?)
    ))
}
fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn root_valid(root: &str) -> bool {
    root.starts_with('/')
        && valid_text(root, 4096)
        && !root.contains('\\')
        && !root.split('/').any(|part| matches!(part, "." | ".."))
}
fn hex_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn unavailable() -> String {
    "远程项目绑定不可用，请在 SSH / WSL 中检查连接并重新打开项目；不会访问本地占位目录。".into()
}

impl RemoteProjects {
    pub fn new(db: Arc<Database>, anchors: PathBuf) -> Self {
        Self {
            db,
            anchors,
            gate: Mutex::new(Gate::default()),
        }
    }
    fn load(&self) -> Result<Store, String> {
        let Some(raw) = self.db.get_setting(KEY).map_err(|_| "远程记录无法读取")? else {
            return Ok(Store::default());
        };
        if raw.len() > MAX_STORE {
            return Err("远程记录超过大小限制，请检查备份".into());
        }
        let store: Store =
            serde_json::from_str(&raw).map_err(|_| "远程记录格式损坏，请检查备份；原记录已保留")?;
        if store.connections.len() > 100
            || store.projects.len() > 500
            || store.connections.iter().any(|(id, c)| {
                id != &c.id || uuid::Uuid::parse_str(id).is_err() || !valid_text(&c.name, 128)
            })
            || store.projects.iter().any(|(id, p)| {
                id != &p.id
                    || !hex_id(id)
                    || !hex_id(&p.target_fingerprint)
                    || !root_valid(&p.root)
                    || !valid_text(&p.name, 256)
            })
        {
            return Err("远程记录内容无效，请检查备份；原记录已保留".into());
        }
        Ok(store)
    }
    fn save(&self, store: &Store) -> Result<(), String> {
        let raw = serde_json::to_string(store).map_err(|_| "远程记录编码失败")?;
        if raw.len() > MAX_STORE {
            return Err("远程记录超过大小限制".into());
        }
        self.db
            .set_setting(KEY, &raw)
            .map_err(|_| "远程记录保存失败".into())
    }
    /// Every path under the dedicated anchor namespace fails closed, even when
    /// its DB entry was lost. It must never become a normal local workspace.
    pub fn owns(&self, anchor: &Path) -> bool {
        let normalize = |p: &Path| {
            let text = p.to_string_lossy();
            let text = text
                .strip_prefix(r"\\?\")
                .unwrap_or(&text)
                .replace('\\', "/");
            path_key(&text)
        };
        let root = normalize(&self.anchors);
        let candidate = normalize(anchor);
        candidate == root || candidate.starts_with(&(root + "/"))
    }
    fn resolve_locked(&self, anchor: &Path, store: &Store) -> Result<ResolvedProject, String> {
        if !self.owns(anchor) {
            return Err(unavailable());
        }
        let id = anchor
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| hex_id(s))
            .ok_or_else(unavailable)?;
        let project = store.projects.get(id).ok_or_else(unavailable)?.clone();
        // Require exactly one directory level, not an arbitrary child with a matching name.
        if path_key(&self.anchor(&project).to_string_lossy().replace('\\', "/"))
            != path_key(
                &anchor
                    .to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .replace('\\', "/"),
            )
        {
            return Err(unavailable());
        }
        let connection = store
            .connections
            .get(&project.connection_id)
            .filter(|c| c.enabled)
            .ok_or_else(unavailable)?
            .clone();
        if fingerprint(&connection.target)? != project.target_fingerprint {
            return Err(unavailable());
        }
        Ok(ResolvedProject {
            project,
            connection,
        })
    }
    pub fn resolve(&self, anchor: &Path) -> Result<ResolvedProject, String> {
        let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        self.resolve_locked(anchor, &self.load()?)
    }
    pub fn anchor(&self, project: &RemoteProject) -> PathBuf {
        self.anchors.join(&project.id)
    }
    pub fn list(&self) -> Result<Value, String> {
        let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let store = self.load()?;
        let projects: Vec<Value> = store.projects.values().map(|p| json!({"id":p.id,"connectionId":p.connection_id,"root":p.root,"name":p.name,"path":self.anchor(p)})).collect();
        Ok(
            json!({"connections":store.connections.values().collect::<Vec<_>>(),"projects":projects}),
        )
    }
    /// A fresh immutable target ID prevents an old project's approvals from
    /// being transferred to a different host. Reconnect does not retarget.
    pub async fn connect(
        &self,
        name: String,
        target: RemoteTarget,
    ) -> Result<RemoteConnection, String> {
        if !valid_text(&name, 128) {
            return Err("请输入不超过 128 字节的连接名称".into());
        }
        target.validate().map_err(|e| e.to_string())?;
        let (_tx, cancel) = watch::channel(false);
        remote_transport::call(&target, "probe", None, json!({}), cancel)
            .await
            .map_err(|e| e.to_string())?;
        let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let mut store = self.load()?;
        if store.connections.len() >= 100 {
            return Err("最多保存 100 个远程连接".into());
        }
        let c = RemoteConnection {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            target,
            enabled: true,
            revision: 1,
        };
        store.connections.insert(c.id.clone(), c.clone());
        self.save(&store)?;
        Ok(c)
    }
    pub async fn reconnect(&self, id: &str) -> Result<RemoteConnection, String> {
        let saved = {
            let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
            self.load()?
                .connections
                .get(id)
                .cloned()
                .ok_or("连接不存在")?
        };
        let (_tx, cancel) = watch::channel(false);
        remote_transport::call(&saved.target, "probe", None, json!({}), cancel)
            .await
            .map_err(|e| e.to_string())?;
        let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let mut store = self.load()?;
        let c = store.connections.get_mut(id).ok_or("连接不存在")?;
        if c.revision != saved.revision || fingerprint(&c.target)? != fingerprint(&saved.target)? {
            return Err("连接状态已改变，请重试".into());
        }
        c.enabled = true;
        c.revision = c.revision.checked_add(1).ok_or("连接版本溢出")?;
        let result = c.clone();
        self.save(&store)?;
        Ok(result)
    }
    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        let gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let mut store = self.load()?;
        let c = store.connections.get_mut(id).ok_or("连接不存在")?;
        c.enabled = false;
        c.revision = c.revision.checked_add(1).ok_or("连接版本溢出")?;
        self.save(&store)?;
        for (connection, stop) in gate.flights.values() {
            if connection == id {
                let _ = stop.send(true);
            }
        }
        Ok(())
    }
    pub async fn attach(
        self: &Arc<Self>,
        connection_id: &str,
        root: &str,
    ) -> Result<RemoteProject, String> {
        if !root_valid(root) {
            return Err("请选择远程绝对 POSIX 目录，例如 /home/user/project".into());
        }
        let (connection, flight, stop) = self.begin(connection_id, None)?;
        let result = remote_transport::call(
            &connection.target,
            "open_project",
            Some(root),
            json!({}),
            stop,
        )
        .await
        .map_err(|e| e.to_string())?;
        drop(flight);
        let root = result["root"]
            .as_str()
            .filter(|r| root_valid(r))
            .ok_or("远端返回的项目目录无效")?
            .to_owned();
        let name = root
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("/")
            .to_owned();
        if !valid_text(&name, 256) {
            return Err("远端项目名称过长".into());
        }
        let target_fingerprint = fingerprint(&connection.target)?;
        let id = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}\0{}\0{}",
                connection.id, target_fingerprint, root
            ))
        );
        let project = RemoteProject {
            id,
            connection_id: connection.id.clone(),
            target_fingerprint,
            root,
            name,
        };
        let _gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let mut store = self.load()?;
        let current = store.connections.get(connection_id).ok_or("连接已移除")?;
        if !current.enabled || current.revision != connection.revision {
            return Err("连接状态已改变，请重新打开项目".into());
        }
        if !store.projects.contains_key(&project.id) && store.projects.len() >= 500 {
            return Err("最多保存 500 个远程项目".into());
        }
        // This directory is an identity only. Never download or mirror source.
        let anchor = self.anchor(&project);
        std::fs::create_dir_all(&anchor).map_err(|_| "无法创建本地远程项目标识")?;
        store.projects.insert(project.id.clone(), project.clone());
        self.save(&store)?;
        Ok(project)
    }
    fn begin(
        self: &Arc<Self>,
        id: &str,
        expected: Option<(&str, u64)>,
    ) -> Result<(RemoteConnection, Flight, watch::Receiver<bool>), String> {
        let mut gate = self.gate.lock().map_err(|_| "远程状态不可用")?;
        let store = self.load()?;
        let c = store
            .connections
            .get(id)
            .filter(|c| c.enabled)
            .ok_or_else(unavailable)?
            .clone();
        if let Some((target, revision)) = expected {
            if fingerprint(&c.target)? != target || c.revision != revision {
                return Err(unavailable());
            }
        }
        if gate.flights.len() >= 64 {
            return Err("远程操作繁忙，请稍后重试".into());
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = watch::channel(false);
        gate.flights.insert(request_id.clone(), (id.into(), tx));
        Ok((
            c,
            Flight {
                owner: self.clone(),
                id: request_id,
            },
            rx,
        ))
    }
    pub async fn call(
        self: &Arc<Self>,
        anchor: &Path,
        operation: &str,
        args: Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Value, String> {
        if *cancel.borrow() {
            return Err("任务已停止".into());
        }
        let resolved = self.resolve(anchor)?;
        let (c, flight, stop) = self.begin(
            &resolved.connection.id,
            Some((
                &resolved.project.target_fingerprint,
                resolved.connection.revision,
            )),
        )?;
        let rpc = remote_transport::call(
            &c.target,
            operation,
            Some(&resolved.project.root),
            args,
            stop,
        );
        tokio::pin!(rpc);
        loop {
            tokio::select! {
                result = &mut rpc => return result.map_err(|e| e.to_string()),
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        if let Ok(gate) = self.gate.lock() { if let Some((_, tx)) = gate.flights.get(&flight.id) { let _ = tx.send(true); } }
                        return rpc.await.map_err(|e| e.to_string());
                    }
                }
            }
        }
    }
}
struct Flight {
    owner: Arc<RemoteProjects>,
    id: String,
}
impl Drop for Flight {
    fn drop(&mut self) {
        if let Ok(mut gate) = self.owner.gate.lock() {
            gate.flights.remove(&self.id);
        }
    }
}

#[cfg(test)]
pub(crate) fn fixture(db: Arc<Database>, anchors: PathBuf) -> (Arc<RemoteProjects>, PathBuf) {
    let service = Arc::new(RemoteProjects::new(db, anchors));
    let c = RemoteConnection {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Fixture SSH".into(),
        target: RemoteTarget::Ssh {
            host: "fixture.invalid".into(),
            port: None,
            username: None,
            identity_file: None,
        },
        enabled: true,
        revision: 1,
    };
    let fp = fingerprint(&c.target).unwrap();
    let root = "/home/fixture/project";
    let id = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}\0{}", c.id, fp, root))
    );
    let p = RemoteProject {
        id,
        connection_id: c.id.clone(),
        target_fingerprint: fp,
        root: root.into(),
        name: "project".into(),
    };
    let anchor = service.anchor(&p);
    std::fs::create_dir_all(&anchor).unwrap();
    service
        .save(&Store {
            connections: [(c.id.clone(), c)].into(),
            projects: [(p.id.clone(), p)].into(),
        })
        .unwrap();
    (service, anchor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_reopen_and_disconnect_preserves_binding_but_revokes_pending_flights() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let (service, anchor) = fixture(db.clone(), dir.path().join("anchors"));
        let binding = service.resolve(&anchor).unwrap();
        let id = binding.connection.id.clone();
        let (_, flight, stopped) = service
            .begin(&id, Some((&binding.project.target_fingerprint, 1)))
            .unwrap();
        let reopened = RemoteProjects::new(db.clone(), dir.path().join("anchors"));
        assert_eq!(
            reopened.resolve(&anchor).unwrap().project.root,
            binding.project.root
        );
        service.disconnect(&id).unwrap();
        assert!(*stopped.borrow());
        assert!(service.resolve(&anchor).is_err());
        assert!(reopened.resolve(&anchor).is_err());
        assert_eq!(
            service.list().unwrap()["projects"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(anchor.is_dir());
        drop(flight);
        assert!(service.gate.lock().unwrap().flights.is_empty());
        assert!(service.begin(&id, None).is_err());
    }

    #[test]
    fn corrupt_missing_and_retargeted_bindings_never_fall_back_to_local() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let (service, anchor) = fixture(db.clone(), dir.path().join("anchors"));
        let binding = service.resolve(&anchor).unwrap();
        let mut store = service.load().unwrap();
        store
            .connections
            .get_mut(&binding.connection.id)
            .unwrap()
            .target = RemoteTarget::Ssh {
            host: "other.invalid".into(),
            port: None,
            username: None,
            identity_file: None,
        };
        service.save(&store).unwrap();
        assert!(service.owns(&anchor));
        assert!(service.resolve(&anchor).is_err());
        assert!(service.resolve(&anchor.join(&binding.project.id)).is_err());
        db.set_setting(KEY, "broken record").unwrap();
        assert!(service.resolve(&anchor).is_err());
        assert!(service.list().is_err());
        assert_eq!(db.get_setting(KEY).unwrap().unwrap(), "broken record");
        let empty = RemoteProjects::new(
            Arc::new(Database::memory().unwrap()),
            dir.path().join("anchors"),
        );
        assert!(empty.owns(&anchor));
        assert!(empty.resolve(&anchor).is_err());
        assert!(!empty.owns(&dir.path().join("anchors-similar/local")));
        assert!(!empty.owns(dir.path()));
    }
}
