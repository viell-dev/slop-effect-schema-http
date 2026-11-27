//! An HTTP/2 client that writes a request's header block field by field, for the heads that no
//! standard client sends: pseudo-header fields that are repeated, late, missing or unknown, names
//! that are not lowercase, and bytes that a value cannot hold.
//!
//! `warded-test-host h2 <directory>` reads one request as JSON on standard input, sends it on a
//! connection of its own to the HTTPS listener at its port, trusting the certificate in
//! `<directory>`, and writes an [`Outcome`] as one line of JSON on standard output: what came back,
//! the server's SETTINGS, and the size of the header block it wrote. With `cleartext`, it sends it
//! to a cleartext listener instead, with prior knowledge (RFC 9113 section 3.3): the preface over
//! TCP, without TLS or an upgrade.
//!
//! Every field goes out as a literal that is neither indexed nor Huffman-coded (RFC 7541 section
//! 6.2.2), in the order given, so the bytes of the header block are the fields as given, and a
//! record of the fields is a record of the wire. Nothing is checked or refused.

use crate::condition::latin1;
use base64::{Engine, prelude::BASE64_STANDARD};
use loona_hpack::Decoder;
use rustls::{
    ClientConfig, RootCertStore,
    crypto::aws_lc_rs,
    pki_types::{CertificateDer, ServerName, pem::PemObject},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    error::Error,
    net::{IpAddr, Ipv4Addr},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, stdin},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::TlsConnector;

type Failure = Box<dyn Error>;
/// A final response head: its status, and its other fields in order.
pub(crate) type Head = (u16, Vec<(String, String)>);

/// One request, for this client or [`crate::h3`]'s. Text stands for bytes, one character for each.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sending {
    pub(crate) port: u16,
    /// The header block, pseudo-header fields included, in order.
    pub(crate) fields: Vec<(String, String)>,
    /// The content in base64. Without it, the HEADERS frame ends the stream.
    pub(crate) body: Option<String>,
    /// Stop at the final response head, as for a CONNECT that opens a tunnel.
    #[serde(default)]
    pub(crate) head_only: bool,
    /// HTTP/2 over TCP without TLS. The HTTP/3 client always uses QUIC's TLS.
    #[serde(default)]
    pub(crate) cleartext: bool,
}

/// The values of a SETTINGS frame, by the names that their RFCs give them.
pub(crate) type Settings = BTreeMap<String, u64>;

/// What a client writes on standard output.
#[derive(Serialize)]
pub(crate) struct Outcome<R> {
    /// What came back for the request.
    pub(crate) received: R,
    /// The first SETTINGS that the server sent, or none when none arrived.
    pub(crate) settings: Option<Settings>,
    /// The size in bytes of the header block or field section that the client wrote: what the
    /// server's limits on encoded heads count.
    pub(crate) block: usize,
    /// How many frames carried it: HEADERS, then CONTINUATION. HTTP/3 has only one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) frames: Option<usize>,
}

/// What came back on the connection.
#[derive(Serialize)]
#[serde(tag = "is", rename_all = "snake_case")]
enum Received {
    /// The final response: its status, its other fields in order, and its content in base64.
    Response {
        status: u16,
        fields: Vec<(String, String)>,
        body: String,
    },
    /// RST_STREAM on the request's stream: a stream error (RFC 9113 section 5.4.2).
    Reset { code: String },
    /// GOAWAY before the response ended: a connection error (RFC 9113 section 5.4.1).
    GoAway { code: String, debug: String },
    /// The connection ended without a response, a reset or a GOAWAY.
    Closed,
}

const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const STREAM: u32 = 1;
/// The largest frame payload that every endpoint takes (RFC 9113 section 4.2), so the request
/// can go out before the server's SETTINGS arrive.
const MAX_PAYLOAD: usize = 16_384;
/// Bodies stay below the initial window of 65 535 bytes, so the client sends no more DATA than
/// it may without reading WINDOW_UPDATE frames.
const MAX_BODY: usize = 65_535;

const DATA: u8 = 0x0;
const HEADERS: u8 = 0x1;
const RST_STREAM: u8 = 0x3;
const SETTINGS: u8 = 0x4;
const PING: u8 = 0x6;
const GOAWAY: u8 = 0x7;
const WINDOW_UPDATE: u8 = 0x8;
const CONTINUATION: u8 = 0x9;

const END_STREAM: u8 = 0x1;
const ACK: u8 = 0x1;
const END_HEADERS: u8 = 0x4;
const PADDED: u8 = 0x8;
const PRIORITY: u8 = 0x20;

/// SETTINGS_ENABLE_PUSH = 0 (RFC 9113 section 6.5.2), so the server opens no stream of its own.
const NO_PUSH: [u8; 6] = [0x0, 0x2, 0x0, 0x0, 0x0, 0x0];

pub async fn send(directory: &Path) -> Result<(), Failure> {
    let mut input = String::new();
    stdin().read_to_string(&mut input).await?;
    let sending: Sending = serde_json::from_str(&input)?;
    let outcome = timeout(Duration::from_secs(10), exchange(directory, &sending))
        .await
        .map_err(|_| "the server did not answer within 10 seconds")??;
    println!("{}", serde_json::to_string(&outcome)?);
    Ok(())
}

async fn exchange(directory: &Path, sending: &Sending) -> Result<Outcome<Received>, Failure> {
    let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, sending.port)).await?;
    if sending.cleartext {
        return over(tcp, sending).await;
    }
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from_pem_file(directory.join("cert.pem"))?)?;
    let mut config = ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    let name = ServerName::from(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let connection = TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await?;
    if connection.get_ref().1.alpn_protocol() != Some(&b"h2"[..]) {
        return Err("the server did not choose HTTP/2".into());
    }
    over(connection, sending).await
}

/// Send the request on a connection that speaks HTTP/2, and read what comes back.
async fn over<C>(mut connection: C, sending: &Sending) -> Result<Outcome<Received>, Failure>
where
    C: AsyncRead + AsyncWrite + Unpin,
{
    let Request {
        bytes,
        block,
        frames,
    } = request(sending)?;
    // A server that refuses a large head can close the connection before it all went out, and
    // then what it sent before says why.
    let written = async {
        connection.write_all(&bytes).await?;
        connection.flush().await
    };
    let _ = written.await;
    let mut settings = None;
    let received = read(&mut connection, sending.head_only, &mut settings).await?;
    Ok(Outcome {
        received,
        settings,
        block,
        frames: Some(frames),
    })
}

/// The bytes of a request, and the size of its header block and the frames that carry it.
struct Request {
    bytes: Vec<u8>,
    block: usize,
    frames: usize,
}

/// The preface, SETTINGS, and the request's HEADERS, CONTINUATION and DATA frames.
fn request(sending: &Sending) -> Result<Request, Failure> {
    let mut block = Vec::new();
    for (name, value) in &sending.fields {
        literal(&latin1(name)?, &latin1(value)?, &mut block);
    }
    let body = match &sending.body {
        Some(body) => Some(BASE64_STANDARD.decode(body)?),
        None => None,
    };
    if body.as_ref().is_some_and(|body| body.len() > MAX_BODY) {
        return Err("the body is larger than the initial window".into());
    }

    let mut out = PREFACE.to_vec();
    frame(SETTINGS, 0, 0, &NO_PUSH, &mut out);
    let pieces: Vec<&[u8]> = if block.is_empty() {
        vec![&[]]
    } else {
        block.chunks(MAX_PAYLOAD).collect()
    };
    let frames = pieces.len();
    for (index, piece) in pieces.iter().enumerate() {
        let (kind, mut flags) = match (index, &body) {
            (0, None) => (HEADERS, END_STREAM),
            (0, Some(_)) => (HEADERS, 0),
            _ => (CONTINUATION, 0),
        };
        if index + 1 == pieces.len() {
            flags |= END_HEADERS;
        }
        frame(kind, flags, STREAM, piece, &mut out);
    }
    if let Some(body) = body {
        let pieces: Vec<&[u8]> = if body.is_empty() {
            vec![&[]]
        } else {
            body.chunks(MAX_PAYLOAD).collect()
        };
        for (index, piece) in pieces.iter().enumerate() {
            let flags = if index + 1 == pieces.len() {
                END_STREAM
            } else {
                0
            };
            frame(DATA, flags, STREAM, piece, &mut out);
        }
    }
    Ok(Request {
        bytes: out,
        block: block.len(),
        frames,
    })
}

/// A literal field line without indexing, with a new name (RFC 7541 section 6.2.2): `0x00`, then
/// the name and the value as plain strings, each a length and its bytes.
fn literal(name: &[u8], value: &[u8], out: &mut Vec<u8>) {
    out.push(0);
    for text in [name, value] {
        integer(text.len(), out);
        out.extend_from_slice(text);
    }
}

/// A string length with a 7-bit prefix and the Huffman bit clear (RFC 7541 section 5.1).
fn integer(value: usize, out: &mut Vec<u8>) {
    const MAX: usize = 0x7f;
    if value < MAX {
        out.push(value as u8);
        return;
    }
    out.push(MAX as u8);
    let mut rest = value - MAX;
    while rest >= 0x80 {
        out.push((rest & 0x7f) as u8 | 0x80);
        rest >>= 7;
    }
    out.push(rest as u8);
}

fn frame(kind: u8, flags: u8, stream: u32, payload: &[u8], out: &mut Vec<u8>) {
    let length = u32::try_from(payload.len()).expect("payloads are at most 16 384 bytes");
    out.extend_from_slice(&length.to_be_bytes()[1..]);
    out.extend_from_slice(&[kind, flags]);
    out.extend_from_slice(&stream.to_be_bytes());
    out.extend_from_slice(payload);
}

/// Read frames until the request's stream ends, is reset, or the connection goes away. SETTINGS
/// and PING are acknowledged, and DATA is given back to both windows. The first SETTINGS go in
/// `settings`.
async fn read<C>(
    connection: &mut C,
    head_only: bool,
    settings: &mut Option<Settings>,
) -> Result<Received, Failure>
where
    C: AsyncRead + AsyncWrite + Unpin,
{
    let mut decoder = Decoder::new();
    let mut block = Vec::new();
    let mut ends_with_block = false;
    let mut head: Option<Head> = None;
    let mut body = Vec::new();
    let mut away = None;
    let mut header = [0; 9];
    while connection.read_exact(&mut header).await.is_ok() {
        let length = u32::from_be_bytes([0, header[0], header[1], header[2]]);
        let (kind, flags) = (header[3], header[4]);
        let stream = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
        let mut payload = vec![0; usize::try_from(length)?];
        if connection.read_exact(&mut payload).await.is_err() {
            break;
        }
        let mut reply = Vec::new();
        let mut ended = false;
        match kind {
            SETTINGS if flags & ACK == 0 => {
                if settings.is_none() {
                    *settings = Some(named(&payload));
                }
                frame(SETTINGS, ACK, 0, &[], &mut reply);
            }
            PING if flags & ACK == 0 => frame(PING, ACK, 0, &payload, &mut reply),
            RST_STREAM if stream == STREAM => {
                return Ok(Received::Reset {
                    code: reason(word(&payload, 0)?),
                });
            }
            GOAWAY => {
                let last = word(&payload, 0)? & 0x7fff_ffff;
                let received = Received::GoAway {
                    code: reason(word(&payload, 4)?),
                    debug: payload[8..].iter().copied().map(char::from).collect(),
                };
                // A stream above the last one the server processed never will be.
                if last < STREAM {
                    return Ok(received);
                }
                away = Some(received);
            }
            HEADERS | CONTINUATION if stream == STREAM => {
                if kind == HEADERS {
                    ends_with_block = flags & END_STREAM != 0;
                    let mut fragment = unpadded(&payload, flags)?;
                    if flags & PRIORITY != 0 {
                        fragment = fragment.get(5..).ok_or("a short PRIORITY")?;
                    }
                    block.extend_from_slice(fragment);
                } else {
                    block.extend_from_slice(&payload);
                }
                if flags & END_HEADERS != 0 {
                    let fields = decoder
                        .decode(&block)
                        .map_err(|error| format!("the response head: {error}"))?;
                    block.clear();
                    if head.is_none() {
                        head = final_head(fields)?;
                    }
                    ended = ends_with_block || (head_only && head.is_some());
                }
            }
            DATA if stream == STREAM => {
                body.extend_from_slice(unpadded(&payload, flags)?);
                ended = flags & END_STREAM != 0;
                if length > 0 && !ended {
                    for stream in [0, STREAM] {
                        frame(WINDOW_UPDATE, 0, stream, &length.to_be_bytes(), &mut reply);
                    }
                }
            }
            _ => {}
        }
        if ended {
            let (status, fields) = head.ok_or("the stream ended without a response")?;
            return Ok(Received::Response {
                status,
                fields,
                body: BASE64_STANDARD.encode(body),
            });
        }
        if !reply.is_empty() && connection.write_all(&reply).await.is_err() {
            break;
        }
    }
    Ok(away.unwrap_or(Received::Closed))
}

/// The status and fields of a final response head, or none for an informational one.
pub(crate) fn final_head(fields: Vec<(Vec<u8>, Vec<u8>)>) -> Result<Option<Head>, Failure> {
    let text = |bytes: Vec<u8>| bytes.into_iter().map(char::from).collect::<String>();
    let mut status = None;
    let mut rest = Vec::new();
    for (name, value) in fields {
        if name == b":status" {
            status = Some(std::str::from_utf8(&value)?.parse::<u16>()?);
        } else {
            rest.push((text(name), text(value)));
        }
    }
    let status = status.ok_or("a response head without :status")?;
    Ok((status >= 200).then_some((status, rest)))
}

/// The fragment of a frame with the PADDED flag, without its padding (RFC 9113 section 6.1).
fn unpadded(payload: &[u8], flags: u8) -> Result<&[u8], Failure> {
    if flags & PADDED == 0 {
        return Ok(payload);
    }
    let (&padding, rest) = payload.split_first().ok_or("an empty padded frame")?;
    let end = rest
        .len()
        .checked_sub(usize::from(padding))
        .ok_or("more padding than payload")?;
    Ok(&rest[..end])
}

/// The parameters of a SETTINGS frame, six bytes each (RFC 9113 section 6.5.1), by name. A later
/// value for the same parameter replaces an earlier one.
fn named(payload: &[u8]) -> Settings {
    let (entries, _) = payload.as_chunks::<6>();
    entries
        .iter()
        .map(|entry| {
            let id = u16::from_be_bytes([entry[0], entry[1]]);
            let value = u32::from_be_bytes([entry[2], entry[3], entry[4], entry[5]]);
            (setting(id), u64::from(value))
        })
        .collect()
}

/// The name of a SETTINGS parameter (RFC 9113 section 6.5.2, RFC 8441, RFC 9218).
fn setting(id: u16) -> String {
    let name = match id {
        0x1 => "SETTINGS_HEADER_TABLE_SIZE",
        0x2 => "SETTINGS_ENABLE_PUSH",
        0x3 => "SETTINGS_MAX_CONCURRENT_STREAMS",
        0x4 => "SETTINGS_INITIAL_WINDOW_SIZE",
        0x5 => "SETTINGS_MAX_FRAME_SIZE",
        0x6 => "SETTINGS_MAX_HEADER_LIST_SIZE",
        0x8 => "SETTINGS_ENABLE_CONNECT_PROTOCOL",
        0x9 => "SETTINGS_NO_RFC7540_PRIORITIES",
        other => return format!("{other:#x}"),
    };
    name.to_owned()
}

/// The 32-bit word at `at` in a payload.
fn word(payload: &[u8], at: usize) -> Result<u32, Failure> {
    let bytes = payload
        .get(at..at + 4)
        .ok_or("a frame too short for its kind")?;
    Ok(u32::from_be_bytes(bytes.try_into()?))
}

/// The name of an error code (RFC 9113 section 7).
fn reason(code: u32) -> String {
    let name = match code {
        0x0 => "NO_ERROR",
        0x1 => "PROTOCOL_ERROR",
        0x2 => "INTERNAL_ERROR",
        0x3 => "FLOW_CONTROL_ERROR",
        0x4 => "SETTINGS_TIMEOUT",
        0x5 => "STREAM_CLOSED",
        0x6 => "FRAME_SIZE_ERROR",
        0x7 => "REFUSED_STREAM",
        0x8 => "CANCEL",
        0x9 => "COMPRESSION_ERROR",
        0xa => "CONNECT_ERROR",
        0xb => "ENHANCE_YOUR_CALM",
        0xc => "INADEQUATE_SECURITY",
        0xd => "HTTP_1_1_REQUIRED",
        other => return format!("{other:#x}"),
    };
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_use_the_seven_bit_prefix() {
        // RFC 7541 section C.1.2 encodes 1337 with a 5-bit prefix; these are the 7-bit cases.
        for (value, expected) in [
            (10, &[0x0a][..]),
            (126, &[0x7e]),
            (127, &[0x7f, 0x00]),
            (128, &[0x7f, 0x01]),
            (255, &[0x7f, 0x80, 0x01]),
            (16_384, &[0x7f, 0x81, 0x7f]),
        ] {
            let mut out = Vec::new();
            integer(value, &mut out);
            assert_eq!(out, expected, "{value}");
        }
    }

    #[test]
    fn settings_are_named() {
        let payload = [
            0x0, 0x3, 0x0, 0x0, 0x0, 0x80, // MAX_CONCURRENT_STREAMS 128
            0x0, 0x6, 0x0, 0x0, 0x80, 0x0, // MAX_HEADER_LIST_SIZE 32 768
            0x0, 0xa, 0x0, 0x0, 0x0, 0x1, // an unknown one
            0x0, 0x6, 0x0, 0x0, 0x40, 0x0, // MAX_HEADER_LIST_SIZE again, 16 384
        ];
        assert_eq!(
            named(&payload),
            Settings::from([
                ("SETTINGS_MAX_CONCURRENT_STREAMS".to_owned(), 128),
                ("SETTINGS_MAX_HEADER_LIST_SIZE".to_owned(), 16_384),
                ("0xa".to_owned(), 1),
            ])
        );
    }

    #[test]
    fn a_literal_decodes_to_its_field() {
        let mut block = Vec::new();
        literal(b":path", b"/a", &mut block);
        literal(b"X-Tag", &[0x80, 0xff, 0x00], &mut block);
        literal(b"long", &[b'a'; 300], &mut block);
        assert_eq!(&block[..10], b"\x00\x05:path\x02/a");
        let decoded = Decoder::new().decode(&block).expect("a valid block");
        assert_eq!(
            decoded,
            [
                (b":path".to_vec(), b"/a".to_vec()),
                (b"X-Tag".to_vec(), vec![0x80, 0xff, 0x00]),
                (b"long".to_vec(), vec![b'a'; 300]),
            ]
        );
    }
}
