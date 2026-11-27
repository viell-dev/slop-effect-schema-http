//! Serves the route tables that the suite's tests describe, and reports what reached them.
//!
//! - `warded-test-host certificate <directory>` writes a certificate for the loopback names.
//! - `warded-test-host serve <directory>` uses it, and takes commands on standard input: one JSON
//!   object per line, answered by one line on standard output. Answers can come out of order: a
//!   command that waits is answered when it is done, and the others meanwhile.
//! - `warded-test-host h2 <directory>` sends one HTTP/2 request that it reads on standard input,
//!   as [`h2`] describes, and writes what came back, with the server's SETTINGS, on standard
//!   output.
//! - `warded-test-host h3 <directory>` does the same over HTTP/3, as [`h3`] describes.

mod condition;
mod h2;
mod h3;
mod table;

use base64::{Engine, prelude::BASE64_STANDARD};
use rcgen::PublicKeyData;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, error::Error, fs, path::Path, time::Duration};
use table::{Definition, Table};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, stdin, stdout},
    sync::mpsc,
};
use warded_server::Tls;

#[derive(Deserialize)]
struct Command {
    id: u64,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
enum Action {
    Open {
        definition: Box<Definition>,
    },
    /// The exchanges from index `from` on.
    Ledger {
        table: u64,
        from: usize,
    },
    Close {
        table: u64,
    },
    /// Wait until the table's streamed replies have ended, for at most `within` milliseconds.
    Settle {
        table: u64,
        within: u64,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["certificate", directory] => certificate(Path::new(directory)),
        ["serve", directory] => serve(Path::new(directory)).await,
        ["h2", directory] => h2::send(Path::new(directory)).await,
        ["h3", directory] => h3::send(Path::new(directory)).await,
        _ => Err("usage: warded-test-host (certificate | serve | h2 | h3) <directory>".into()),
    }
}

/// Write `cert.pem`, `key.pem`, and the hash of the public key that tells Chromium to accept it.
fn certificate(directory: &Path) -> Result<(), Box<dyn Error>> {
    let names = ["localhost".to_owned(), "127.0.0.1".to_owned()];
    let generated = rcgen::generate_simple_self_signed(names)?;
    let spki = Sha256::digest(generated.signing_key.subject_public_key_info());
    fs::create_dir_all(directory)?;
    fs::write(directory.join("cert.pem"), generated.cert.pem())?;
    fs::write(
        directory.join("key.pem"),
        generated.signing_key.serialize_pem(),
    )?;
    fs::write(directory.join("spki.txt"), BASE64_STANDARD.encode(spki))?;
    Ok(())
}

async fn serve(directory: &Path) -> Result<(), Box<dyn Error>> {
    let tls = Tls::pem_files(directory.join("cert.pem"), directory.join("key.pem"))?;
    let mut tables = HashMap::new();
    let mut lines = BufReader::new(stdin()).lines();
    let (answers, mut answered) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut output = stdout();
        while let Some(answer) = answered.recv().await {
            output.write_all(format!("{answer}\n").as_bytes()).await?;
            output.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let answer = |id: u64, result: Result<Value, String>| match result {
        Ok(value) => json!({ "id": id, "ok": value }),
        Err(error) => json!({ "id": id, "error": error }),
    };
    while let Some(line) = lines.next_line().await? {
        let Command { id, action } = serde_json::from_str(&line)?;
        if let Action::Settle { table, within } = action {
            // Other tests' commands go on while this one waits.
            let Some(streams) = tables.get(&table).map(|open: &Table| open.streams.clone()) else {
                answers.send(answer(id, Err(format!("no table {table}"))))?;
                continue;
            };
            let answers = answers.clone();
            tokio::spawn(async move {
                streams.settle(Duration::from_millis(within)).await;
                let _ = answers.send(answer(id, Ok(Value::Null)));
            });
            continue;
        }
        answers.send(answer(id, perform(id, action, &mut tables, &tls).await))?;
    }
    drop(answers);
    writer.await??;
    Ok(())
}

/// A table is named by the command that opened it.
async fn perform(
    id: u64,
    action: Action,
    tables: &mut HashMap<u64, Table>,
    tls: &Tls,
) -> Result<Value, String> {
    let unknown = |table| format!("no table {table}");
    match action {
        Action::Settle { .. } => Err("settle is answered by `serve`".to_owned()),
        Action::Open { definition } => {
            let table = Table::open(&definition, tls).await?;
            let ports = table.ports;
            tables.insert(id, table);
            Ok(json!({ "table": id, "ports": ports }))
        }
        Action::Ledger { table, from } => {
            let ledger = &tables.get(&table).ok_or_else(|| unknown(table))?.ledger;
            let exchanges = ledger.lock().expect("no holder of the ledger panics");
            Ok(json!(exchanges.get(from..).unwrap_or_default()))
        }
        Action::Close { table } => {
            tables.remove(&table).ok_or_else(|| unknown(table))?;
            Ok(Value::Null)
        }
    }
}
