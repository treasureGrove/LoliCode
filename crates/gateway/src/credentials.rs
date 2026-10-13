use crate::error::{Result, SafeError};
use zeroize::Zeroizing;

pub trait Credentials: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>>;
    fn set(&self, id: &str, value: &str) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}

pub struct SystemCredentials {
    service: String,
}
impl Default for SystemCredentials {
    fn default() -> Self {
        Self::new("art.treasuregrove.freehub".into())
    }
}
impl SystemCredentials {
    pub fn new(service: String) -> Self {
        Self { service }
    }
}

#[cfg(windows)]
impl Credentials for SystemCredentials {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
        let entry = keyring::Entry::new(&self.service, id).map_err(|_| SafeError::credentials())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SafeError::credentials()),
        }
    }
    fn set(&self, id: &str, value: &str) -> Result<()> {
        keyring::Entry::new(&self.service, id)
            .map_err(|_| SafeError::credentials())?
            .set_password(value)
            .map_err(|_| SafeError::credentials())
    }
    fn delete(&self, id: &str) -> Result<()> {
        let entry = keyring::Entry::new(&self.service, id).map_err(|_| SafeError::credentials())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SafeError::credentials()),
        }
    }
}

#[cfg(not(windows))]
impl Credentials for SystemCredentials {
    fn get(&self, _: &str) -> Result<Option<Zeroizing<String>>> {
        Err(SafeError::credentials())
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        Err(SafeError::credentials())
    }
    fn delete(&self, _: &str) -> Result<()> {
        Err(SafeError::credentials())
    }
}

#[cfg(test)]
pub(crate) mod memory {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};
    #[derive(Default)]
    pub struct MemoryCredentials(pub Mutex<HashMap<String, String>>);
    impl Credentials for MemoryCredentials {
        fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
            Ok(self.0.lock().unwrap().get(id).cloned().map(Zeroizing::new))
        }
        fn set(&self, id: &str, v: &str) -> Result<()> {
            self.0.lock().unwrap().insert(id.into(), v.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<()> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
}
