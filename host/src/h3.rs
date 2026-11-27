//! An HTTP/3 client that writes a request's field section field by field, for the heads that no
//! standard client sends, as [`crate::h2`] does over HTTP/2.
//!
//! `warded-test-host h3 <directory>` reads one request as JSON on standard input, in the form that
//! [`Sending`] describes, sends it on a QUIC connection of its own to the HTTPS listener's HTTP/3
//! endpoint at its port, trusting the certificate in `<directory>`, and writes what came back as one
//! line of JSON on standard output.
//!
//! QUIC comes from Quinn, at the version and with the features that the Warded Server uses, so the
//! client adds no crate. HTTP/3 framing (RFC 9114) and QPACK (RFC 9204) are written here: h3's
//! client builds a field section from the `http` crate's types, which hold none of these heads, and
//! does not expose its encoder. Every field goes out as a literal field line with a literal name
//! (RFC 9204 section 4.5.6), neither Huffman-coded nor in the dynamic table, which the client never
//! allows, in the order given. So the bytes of the field section are the fields as given, and a
//! record of the fields is a record of the wire. Nothing is checked or refused.

use crate::{
    condition::latin1,
    h2::{Head, Sending, final_head},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use loona_hpack::huffman::HuffmanDecoder;
use quinn::{
    ClientConfig, Connection, ConnectionError, Endpoint, ReadError, ReadExactError, RecvStream,
    crypto::rustls::QuicClientConfig,
};
use rustls::{
    RootCertStore,
    crypto::aws_lc_rs,
    pki_types::{CertificateDer, pem::PemObject},
    version::TLS13,
};
use serde::Serialize;
use std::{
    error::Error,
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, stdin},
    time::timeout,
};

type Failure = Box<dyn Error>;
type Fields = Vec<(Vec<u8>, Vec<u8>)>;

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
    /// RESET_STREAM on the request stream: a stream error (RFC 9114 section 8).
    Reset { code: String },
    /// CONNECTION_CLOSE before the response ended: a connection error (RFC 9114 section 8), with
    /// HTTP/3's code, or QUIC's when QUIC itself closed it.
    Close { code: String, reason: String },
    /// The connection ended without a response, a reset or a close.
    Closed,
}

/// Why a stream could not be read to its end.
enum Stopped {
    Read(ReadError),
    Malformed(&'static str),
}

impl From<ReadExactError> for Stopped {
    fn from(error: ReadExactError) -> Self {
        match error {
            ReadExactError::FinishedEarly(_) => Self::Malformed("the stream ends inside a frame"),
            ReadExactError::ReadError(error) => Self::Read(error),
        }
    }
}

/// Frame types (RFC 9114 section 7.2).
const DATA: u64 = 0x0;
const HEADERS: u64 = 0x1;
const SETTINGS: u64 = 0x4;
/// The type of a control stream (RFC 9114 section 6.2.1).
const CONTROL_STREAM: u64 = 0x0;
/// H3_NO_ERROR, for closing the connection once the response has arrived.
const NO_ERROR: u32 = 0x100;
/// The largest response frame that the client reads. The routes' answers are far smaller.
const MAX_FRAME: u64 = 1 << 24;

pub async fn send(directory: &Path) -> Result<(), Failure> {
    let mut input = String::new();
    stdin().read_to_string(&mut input).await?;
    let sending: Sending = serde_json::from_str(&input)?;
    let received = timeout(Duration::from_secs(10), exchange(directory, &sending))
        .await
        .map_err(|_| "the server did not answer within 10 seconds")??;
    println!("{}", serde_json::to_string(&received)?);
    Ok(())
}

async fn exchange(directory: &Path, sending: &Sending) -> Result<Received, Failure> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from_pem_file(directory.join("cert.pem"))?)?;
    let mut tls =
        rustls::ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
            .with_protocol_versions(&[&TLS13])?
            .with_root_certificates(roots)
            .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let mut endpoint = Endpoint::client(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    endpoint.set_default_client_config(ClientConfig::new(Arc::new(QuicClientConfig::try_from(
        tls,
    )?)));
    let server = SocketAddr::from((Ipv4Addr::LOCALHOST, sending.port));
    let connection = endpoint.connect(server, "127.0.0.1")?.await?;
    let received = request(&connection, sending).await;
    // Tell the server, so that it does not wait for the connection to go idle.
    connection.close(NO_ERROR.into(), b"");
    let _ = timeout(Duration::from_secs(1), endpoint.wait_idle()).await;
    received
}

/// Open the control stream, send the request on a stream of its own, and read what comes back.
async fn request(connection: &Connection, sending: &Sending) -> Result<Received, Failure> {
    // Empty SETTINGS leave the dynamic table's capacity at 0, so the server's encoder uses none
    // (RFC 9204 section 3.2.3). The stream stays open while the connection is used, since closing
    // it is a connection error (RFC 9114 section 6.2.1). Without a dynamic table, the client needs
    // no QPACK streams (RFC 9204 section 4.2).
    let mut control = connection.open_uni().await?;
    let mut settings = Vec::new();
    varint(CONTROL_STREAM, &mut settings);
    frame(SETTINGS, &[], &mut settings);
    control.write_all(&settings).await?;

    let (mut out, mut stream) = connection.open_bi().await?;
    // A server that refuses the request can stop reading it before it all went out, and then
    // what it answers says why.
    let _ = out.write_all(&message(sending)?).await;
    let _ = out.finish();
    match read(&mut stream, sending.head_only).await {
        Ok(head) => Ok(head),
        Err(Stopped::Read(ReadError::Reset(code))) => Ok(Received::Reset {
            code: reason(code.into_inner()),
        }),
        Err(Stopped::Read(ReadError::ConnectionLost(error))) => lost(error),
        Err(Stopped::Read(error)) => Err(error.into()),
        Err(Stopped::Malformed(why)) => Err(why.into()),
    }
}

/// The request's HEADERS frame and DATA frame (RFC 9114 section 4.1). An empty body has no DATA
/// frame, since h3 takes an empty one for the end of the content.
fn message(sending: &Sending) -> Result<Vec<u8>, Failure> {
    // Required Insert Count 0 and Base 0 (RFC 9204 section 4.5.1): no dynamic table.
    let mut section = vec![0, 0];
    for (name, value) in &sending.fields {
        literal(&latin1(name)?, &latin1(value)?, &mut section);
    }
    let mut out = Vec::new();
    frame(HEADERS, &section, &mut out);
    if let Some(body) = &sending.body {
        let body = BASE64_STANDARD.decode(body)?;
        if !body.is_empty() {
            frame(DATA, &body, &mut out);
        }
    }
    Ok(out)
}

/// A literal field line with a literal name (RFC 9204 section 4.5.6): `001` and the N bit clear,
/// then the name as a plain string with a 3-bit length prefix, and the value as one with a 7-bit
/// prefix, their H bits clear.
fn literal(name: &[u8], value: &[u8], out: &mut Vec<u8>) {
    integer(name.len(), 3, 0b0010_0000, out);
    out.extend_from_slice(name);
    integer(value.len(), 7, 0, out);
    out.extend_from_slice(value);
}

/// An integer with a prefix of `bits` bits after the bits of `flags` (RFC 7541 section 5.1, which
/// RFC 9204 section 4.1.1 uses).
fn integer(value: usize, bits: u32, flags: u8, out: &mut Vec<u8>) {
    let max = (1 << bits) - 1;
    if value < max {
        out.push(flags | value as u8);
        return;
    }
    out.push(flags | max as u8);
    let mut rest = value - max;
    while rest >= 0x80 {
        out.push((rest & 0x7f) as u8 | 0x80);
        rest >>= 7;
    }
    out.push(rest as u8);
}

/// A variable-length integer of QUIC (RFC 9000 section 16), below 2^62.
fn varint(value: u64, out: &mut Vec<u8>) {
    match value {
        0..0x40 => out.push(value as u8),
        0x40..0x4000 => out.extend_from_slice(&(value as u16 | 0x4000).to_be_bytes()),
        0x4000..0x4000_0000 => out.extend_from_slice(&(value as u32 | 0x8000_0000).to_be_bytes()),
        _ => out.extend_from_slice(&(value | 0xc000_0000_0000_0000).to_be_bytes()),
    }
}

fn frame(kind: u64, payload: &[u8], out: &mut Vec<u8>) {
    varint(kind, out);
    varint(payload.len() as u64, out);
    out.extend_from_slice(payload);
}

/// Read frames until the stream ends, or the final response head for `head_only`. Frames of
/// other types, such as h3's greasing ones, are skipped (RFC 9114 section 9), and so are trailers.
async fn read(stream: &mut RecvStream, head_only: bool) -> Result<Received, Stopped> {
    let mut head: Option<Head> = None;
    let mut body = Vec::new();
    while let Some((kind, payload)) = next_frame(stream).await? {
        match kind {
            HEADERS if head.is_none() => {
                let fields = decode(&payload).map_err(Stopped::Malformed)?;
                head = final_head(fields).map_err(|_| Stopped::Malformed("a bad :status"))?;
                if head_only && head.is_some() {
                    break;
                }
            }
            DATA => body.extend_from_slice(&payload),
            _ => {}
        }
    }
    let (status, fields) = head.ok_or(Stopped::Malformed("the stream ended without a response"))?;
    Ok(Received::Response {
        status,
        fields,
        body: BASE64_STANDARD.encode(body),
    })
}

/// The next frame's type and payload, or none where the stream ends between frames.
async fn next_frame(stream: &mut RecvStream) -> Result<Option<(u64, Vec<u8>)>, Stopped> {
    let mut first = [0];
    match stream.read_exact(&mut first).await {
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        read => read?,
    }
    let kind = rest_of_varint(first[0], stream).await?;
    let mut first = [0];
    stream.read_exact(&mut first).await?;
    let length = rest_of_varint(first[0], stream).await?;
    if length > MAX_FRAME {
        return Err(Stopped::Malformed("a frame larger than the client reads"));
    }
    let mut payload = vec![0; length as usize];
    stream.read_exact(&mut payload).await?;
    Ok(Some((kind, payload)))
}

/// A variable-length integer whose first byte has been read: its two high bits give its length.
async fn rest_of_varint(first: u8, stream: &mut RecvStream) -> Result<u64, Stopped> {
    let length = 1 << (first >> 6);
    let mut bytes = [0; 8];
    bytes[8 - length] = first & 0x3f;
    stream.read_exact(&mut bytes[9 - length..]).await?;
    Ok(u64::from_be_bytes(bytes))
}

fn lost(error: ConnectionError) -> Result<Received, Failure> {
    let text = |reason: &[u8]| -> String { reason.iter().copied().map(char::from).collect() };
    match error {
        ConnectionError::ApplicationClosed(close) => Ok(Received::Close {
            code: reason(close.error_code.into_inner()),
            reason: text(&close.reason[..]),
        }),
        ConnectionError::ConnectionClosed(close) => Ok(Received::Close {
            code: format!("{:?}", close.error_code),
            reason: text(&close.reason[..]),
        }),
        ConnectionError::Reset | ConnectionError::TimedOut => Ok(Received::Closed),
        error => Err(error.into()),
    }
}

/// Decode a field section that uses no dynamic table (RFC 9204 section 4.5), as the client's
/// settings require of the server. Strings may be Huffman-coded (RFC 9204 section 4.1.2).
fn decode(section: &[u8]) -> Result<Fields, &'static str> {
    const DYNAMIC: &str = "the response head refers to a dynamic table";
    let mut rest = section;
    let required = prefixed(&mut rest, 8)?;
    prefixed(&mut rest, 7)?;
    if required != 0 {
        return Err(DYNAMIC);
    }
    let mut fields = Vec::new();
    while let Some(&first) = rest.first() {
        let field = if first & 0x80 != 0 {
            // An indexed field line (section 4.5.2), whose T bit says the static table.
            if first & 0x40 == 0 {
                return Err(DYNAMIC);
            }
            let (name, value) = entry(prefixed(&mut rest, 6)?)?;
            (name.as_bytes().to_vec(), value.as_bytes().to_vec())
        } else if first & 0xc0 == 0x40 {
            // A literal field line with a name reference (section 4.5.4).
            if first & 0x10 == 0 {
                return Err(DYNAMIC);
            }
            let (name, _) = entry(prefixed(&mut rest, 4)?)?;
            (name.as_bytes().to_vec(), string(&mut rest, 7)?)
        } else if first & 0xe0 == 0x20 {
            // A literal field line with a literal name (section 4.5.6).
            let name = string(&mut rest, 3)?;
            (name, string(&mut rest, 7)?)
        } else {
            // The post-base forms (sections 4.5.3 and 4.5.5) refer to the dynamic table only.
            return Err(DYNAMIC);
        };
        fields.push(field);
    }
    Ok(fields)
}

/// An integer with a prefix of `bits` bits (RFC 7541 section 5.1), taken from the front of `rest`.
fn prefixed(rest: &mut &[u8], bits: u32) -> Result<usize, &'static str> {
    const SHORT: &str = "the response head ends inside a field line";
    let max = (1 << bits) - 1;
    let (&first, tail) = rest.split_first().ok_or(SHORT)?;
    *rest = tail;
    let mut value = usize::from(first) & max;
    if value < max {
        return Ok(value);
    }
    for shift in (0..=56).step_by(7) {
        let (&byte, tail) = rest.split_first().ok_or(SHORT)?;
        *rest = tail;
        value += usize::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("an integer in the response head is too large")
}

/// A string with a length prefix of `bits` bits, after its H bit (RFC 9204 section 4.1.2).
fn string(rest: &mut &[u8], bits: u32) -> Result<Vec<u8>, &'static str> {
    let huffman = rest.first().is_some_and(|first| first & (1 << bits) != 0);
    let length = prefixed(rest, bits)?;
    if length > rest.len() {
        return Err("the response head ends inside a string");
    }
    let (bytes, tail) = rest.split_at(length);
    *rest = tail;
    if huffman {
        HuffmanDecoder::new()
            .decode(bytes)
            .map_err(|_| "a Huffman-coded string in the response head is invalid")
    } else {
        Ok(bytes.to_vec())
    }
}

fn entry(index: usize) -> Result<(&'static str, &'static str), &'static str> {
    STATIC
        .get(index)
        .copied()
        .ok_or("the response head refers to no entry of the static table")
}

/// The name of an error code (RFC 9114 section 8.1, RFC 9204 section 6).
fn reason(code: u64) -> String {
    let name = match code {
        0x100 => "H3_NO_ERROR",
        0x101 => "H3_GENERAL_PROTOCOL_ERROR",
        0x102 => "H3_INTERNAL_ERROR",
        0x103 => "H3_STREAM_CREATION_ERROR",
        0x104 => "H3_CLOSED_CRITICAL_STREAM",
        0x105 => "H3_FRAME_UNEXPECTED",
        0x106 => "H3_FRAME_ERROR",
        0x107 => "H3_EXCESSIVE_LOAD",
        0x108 => "H3_ID_ERROR",
        0x109 => "H3_SETTINGS_ERROR",
        0x10a => "H3_MISSING_SETTINGS",
        0x10b => "H3_REQUEST_REJECTED",
        0x10c => "H3_REQUEST_CANCELLED",
        0x10d => "H3_REQUEST_INCOMPLETE",
        0x10e => "H3_MESSAGE_ERROR",
        0x10f => "H3_CONNECT_ERROR",
        0x110 => "H3_VERSION_FALLBACK",
        0x200 => "QPACK_DECOMPRESSION_FAILED",
        0x201 => "QPACK_ENCODER_STREAM_ERROR",
        0x202 => "QPACK_DECODER_STREAM_ERROR",
        other => return format!("{other:#x}"),
    };
    name.to_owned()
}

/// The static table (RFC 9204 appendix A).
const STATIC: [(&str, &str); 99] = [
    (":authority", ""),
    (":path", "/"),
    ("age", "0"),
    ("content-disposition", ""),
    ("content-length", "0"),
    ("cookie", ""),
    ("date", ""),
    ("etag", ""),
    ("if-modified-since", ""),
    ("if-none-match", ""),
    ("last-modified", ""),
    ("link", ""),
    ("location", ""),
    ("referer", ""),
    ("set-cookie", ""),
    (":method", "CONNECT"),
    (":method", "DELETE"),
    (":method", "GET"),
    (":method", "HEAD"),
    (":method", "OPTIONS"),
    (":method", "POST"),
    (":method", "PUT"),
    (":scheme", "http"),
    (":scheme", "https"),
    (":status", "103"),
    (":status", "200"),
    (":status", "304"),
    (":status", "404"),
    (":status", "503"),
    ("accept", "*/*"),
    ("accept", "application/dns-message"),
    ("accept-encoding", "gzip, deflate, br"),
    ("accept-ranges", "bytes"),
    ("access-control-allow-headers", "cache-control"),
    ("access-control-allow-headers", "content-type"),
    ("access-control-allow-origin", "*"),
    ("cache-control", "max-age=0"),
    ("cache-control", "max-age=2592000"),
    ("cache-control", "max-age=604800"),
    ("cache-control", "no-cache"),
    ("cache-control", "no-store"),
    ("cache-control", "public, max-age=31536000"),
    ("content-encoding", "br"),
    ("content-encoding", "gzip"),
    ("content-type", "application/dns-message"),
    ("content-type", "application/javascript"),
    ("content-type", "application/json"),
    ("content-type", "application/x-www-form-urlencoded"),
    ("content-type", "image/gif"),
    ("content-type", "image/jpeg"),
    ("content-type", "image/png"),
    ("content-type", "text/css"),
    ("content-type", "text/html; charset=utf-8"),
    ("content-type", "text/plain"),
    ("content-type", "text/plain;charset=utf-8"),
    ("range", "bytes=0-"),
    ("strict-transport-security", "max-age=31536000"),
    (
        "strict-transport-security",
        "max-age=31536000; includesubdomains",
    ),
    (
        "strict-transport-security",
        "max-age=31536000; includesubdomains; preload",
    ),
    ("vary", "accept-encoding"),
    ("vary", "origin"),
    ("x-content-type-options", "nosniff"),
    ("x-xss-protection", "1; mode=block"),
    (":status", "100"),
    (":status", "204"),
    (":status", "206"),
    (":status", "302"),
    (":status", "400"),
    (":status", "403"),
    (":status", "421"),
    (":status", "425"),
    (":status", "500"),
    ("accept-language", ""),
    ("access-control-allow-credentials", "FALSE"),
    ("access-control-allow-credentials", "TRUE"),
    ("access-control-allow-headers", "*"),
    ("access-control-allow-methods", "get"),
    ("access-control-allow-methods", "get, post, options"),
    ("access-control-allow-methods", "options"),
    ("access-control-expose-headers", "content-length"),
    ("access-control-request-headers", "content-type"),
    ("access-control-request-method", "get"),
    ("access-control-request-method", "post"),
    ("alt-svc", "clear"),
    ("authorization", ""),
    (
        "content-security-policy",
        "script-src 'none'; object-src 'none'; base-uri 'none'",
    ),
    ("early-data", "1"),
    ("expect-ct", ""),
    ("forwarded", ""),
    ("if-range", ""),
    ("origin", ""),
    ("purpose", "prefetch"),
    ("server", ""),
    ("timing-allow-origin", "*"),
    ("upgrade-insecure-requests", "1"),
    ("user-agent", ""),
    ("x-forwarded-for", ""),
    ("x-frame-options", "deny"),
    ("x-frame-options", "sameorigin"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_use_their_prefix() {
        // RFC 7541 section C.1, and the lengths of the two prefixes that a literal name uses.
        for (value, bits, flags, expected) in [
            (10, 5, 0, &[0x0a][..]),
            (1337, 5, 0, &[0x1f, 0x9a, 0x0a]),
            (42, 8, 0, &[0x2a]),
            (6, 3, 0x20, &[0x26]),
            (7, 3, 0x20, &[0x27, 0x00]),
            (300, 7, 0, &[0x7f, 0xad, 0x01]),
        ] {
            let mut out = Vec::new();
            integer(value, bits, flags, &mut out);
            assert_eq!(out, expected, "{value}");
            let mut rest = &out[..];
            assert_eq!(prefixed(&mut rest, bits), Ok(value), "{value}");
            assert!(rest.is_empty());
        }
    }

    #[test]
    fn varints_have_their_length_in_the_first_byte() {
        // RFC 9000 section A.1.
        for (value, expected) in [
            (37, &[0x25][..]),
            (15_293, &[0x7b, 0xbd]),
            (494_878_333, &[0x9d, 0x7f, 0x3e, 0x7d]),
            (
                151_288_809_941_952_652,
                &[0xc2, 0x19, 0x7c, 0x5e, 0xff, 0x14, 0xe8, 0x8c],
            ),
        ] {
            let mut out = Vec::new();
            varint(value, &mut out);
            assert_eq!(out, expected, "{value}");
        }
    }

    #[test]
    fn a_literal_decodes_to_its_field() {
        let mut section = vec![0, 0];
        literal(b":path", b"/a", &mut section);
        literal(b"X-Tag", &[0x80, 0xff, 0x00], &mut section);
        literal(b"long", &[b'a'; 300], &mut section);
        assert_eq!(&section[..11], b"\x00\x00\x25:path\x02/a");
        assert_eq!(
            decode(&section),
            Ok(vec![
                (b":path".to_vec(), b"/a".to_vec()),
                (b"X-Tag".to_vec(), vec![0x80, 0xff, 0x00]),
                (b"long".to_vec(), vec![b'a'; 300]),
            ])
        );
    }

    #[test]
    fn responses_may_use_the_static_table_and_huffman_codes() {
        // `:status: 200` indexed, `:authority` by reference with the Huffman code of
        // `www.example.com` from RFC 7541 section C.4.1, and `:path: /index.html` from RFC 9204
        // section B.1.
        let section = b"\x00\x00\xd9\x50\x8c\xf1\xe3\xc2\xe5\xf2\x3a\x6b\xa0\xab\x90\xf4\xff\
            \x51\x0b/index.html";
        assert_eq!(
            decode(section),
            Ok(vec![
                (b":status".to_vec(), b"200".to_vec()),
                (b":authority".to_vec(), b"www.example.com".to_vec()),
                (b":path".to_vec(), b"/index.html".to_vec()),
            ])
        );
        assert_eq!(STATIC[98], ("x-frame-options", "sameorigin"));
        for dynamic in [
            &b"\x01\x00"[..],
            b"\x00\x00\x80",
            b"\x00\x00\x10",
            b"\x00\x00\x40\x00",
        ] {
            assert!(decode(dynamic).is_err(), "{dynamic:?}");
        }
    }
}
