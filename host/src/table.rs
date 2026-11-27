//! One test's route table: its routes, its listeners, and what reached it.

use crate::condition::{Condition, OfferSet};
use base64::{Engine, prelude::BASE64_STANDARD};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize, Serializer};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::Notify,
    task::JoinSet,
    time::{Instant, sleep, timeout_at},
};
use tower::service_fn;
use warded_server::{
    Limits, Params, Server, Tls,
    axum::{
        self,
        body::Body,
        extract::{FromRequestParts, Request, State},
        http::{HeaderName, HeaderValue, Method, StatusCode, Version, header},
        middleware::{self, Next},
        response::Response,
    },
    warded::{Captures, Head, MatchError, Router, Selection, TransportSecurity},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    routes: Vec<Route>,
    fallback: Option<Target>,
    #[serde(default)]
    offers: BTreeMap<String, OfferSet>,
    /// Answer CORS preflights outside the routes, and let a page read every response.
    #[serde(default)]
    cors: bool,
    /// A fixed port for the HTTPS listener, for a browser that was started to use HTTP/3 there.
    #[serde(default)]
    https_port: u16,
    /// Override the server's head limit for tests of larger router limits.
    head_bytes: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct Route {
    when: Condition,
    #[serde(flatten)]
    target: Target,
}

/// What a selected route answers. Without a `reply` or a `lookup`, the selection itself, as JSON.
#[derive(Clone, Debug, Deserialize)]
struct Target {
    name: String,
    reply: Option<Reply>,
    lookup: Option<Lookup>,
}

/// A handler that answers by the value of one capture, as the server's `Params` extractor decodes
/// it, the way an application looks a record up by its id: the reply `by` lists for that value, or
/// `otherwise`, which also answers when the capture cannot be decoded.
#[derive(Clone, Debug, Deserialize)]
struct Lookup {
    capture: String,
    by: BTreeMap<String, Reply>,
    otherwise: Reply,
}

impl Lookup {
    fn reply(&self, params: Option<&BTreeMap<String, String>>) -> &Reply {
        params
            .and_then(|params| params.get(&self.capture))
            .and_then(|value| self.by.get(value))
            .unwrap_or(&self.otherwise)
    }

    fn replies(&self) -> impl Iterator<Item = &Reply> {
        self.by.values().chain([&self.otherwise])
    }
}

/// A handler's answer. Its content is `body` as text, or `bytes` in base64, or what `stream` writes;
/// a reply has at most one of them.
#[derive(Clone, Debug, Deserialize)]
struct Reply {
    status: u16,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: String,
    bytes: Option<String>,
    stream: Option<Streamed>,
}

/// Content that a handler writes piece by piece, as one that streams an export or events does:
/// each chunk after a delay, and after the last, what `ending` says. The server takes each chunk as
/// it comes, so the reply's head goes out before its content, without a length unless the reply
/// declares one.
#[derive(Clone, Debug, Deserialize)]
struct Streamed {
    chunks: Vec<Chunk>,
    ending: Ending,
}

#[derive(Clone, Debug, Deserialize)]
struct Chunk {
    /// The milliseconds to wait before writing it.
    after: u64,
    text: String,
}

/// What a streamed reply does after its last chunk.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Ending {
    /// End the content, whatever length the head declared.
    End,
    /// Write nothing more, and never end: the response stays open.
    Stall,
    /// Fail the content with an error, as a handler does whose source fails in the middle.
    Fail,
    /// Write the chunks again, forever.
    Repeat,
}

/// How far the content of a streamed reply got.
#[derive(Clone, Copy, Debug, Default, Serialize)]
struct Progress {
    /// The chunks that the server took from the content.
    chunks: usize,
    /// How the content ended, or `None` while the server can still take more.
    ended: Option<Ended>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Ended {
    /// After the last chunk, as `Ending::End` says.
    Finished,
    /// With the error of `Ending::Fail`.
    Failed,
    /// The server dropped the content before it ended: the client went away, or the connection
    /// or stream failed.
    Dropped,
}

/// The progress of one streamed reply, which its content goes on updating after the exchange is
/// recorded. It is serialized as it stands when the ledger is read.
#[derive(Clone, Debug, Default)]
struct Watched(Arc<Mutex<Progress>>);

impl Serialize for Watched {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let progress = *self.0.lock().expect("no holder of a progress panics");
        progress.serialize(serializer)
    }
}

/// The streamed replies of a table that have not ended, so that a test can wait for them.
#[derive(Debug, Default)]
pub struct Streams {
    open: Mutex<usize>,
    changed: Notify,
}

impl Streams {
    /// Wait until no streamed reply of the table is open, or `within` has passed.
    pub async fn settle(&self, within: Duration) {
        let deadline = Instant::now() + within;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if *self.open.lock().expect("no holder of the count panics") == 0 {
                return;
            }
            if timeout_at(deadline, changed).await.is_err() {
                return;
            }
        }
    }
}

/// The content of one streamed reply, with what it records of its progress. Dropping it before
/// it ended records that it was dropped.
struct Writing {
    streamed: Streamed,
    next: usize,
    failed: bool,
    watched: Watched,
    streams: Arc<Streams>,
}

impl Writing {
    fn start(streamed: Streamed, streams: Arc<Streams>) -> Self {
        *streams.open.lock().expect("no holder of the count panics") += 1;
        Self {
            streamed,
            next: 0,
            failed: false,
            watched: Watched::default(),
            streams,
        }
    }

    /// Record the end, unless the content has ended already.
    fn end(&self, how: Ended) {
        let mut progress = self
            .watched
            .0
            .lock()
            .expect("no holder of a progress panics");
        if progress.ended.is_none() {
            progress.ended = Some(how);
            drop(progress);
            *self
                .streams
                .open
                .lock()
                .expect("no holder of the count panics") -= 1;
            self.streams.changed.notify_waiters();
        }
    }

    /// The next piece of content, or `None` at its end.
    async fn next(&mut self) -> Option<Result<axum::body::Bytes, io::Error>> {
        if self.failed {
            return None;
        }
        if self.next == self.streamed.chunks.len() {
            match self.streamed.ending {
                Ending::End => {
                    self.end(Ended::Finished);
                    return None;
                }
                Ending::Stall => std::future::pending::<()>().await,
                Ending::Fail => {
                    self.failed = true;
                    self.end(Ended::Failed);
                    return Some(Err(io::Error::other("the streamed content failed")));
                }
                Ending::Repeat => self.next = 0,
            }
        }
        let chunk = &self.streamed.chunks[self.next];
        sleep(Duration::from_millis(chunk.after)).await;
        self.next += 1;
        self.watched
            .0
            .lock()
            .expect("no holder of a progress panics")
            .chunks += 1;
        Some(Ok(axum::body::Bytes::from(chunk.text.clone())))
    }

    fn body(self) -> Body {
        Body::from_stream(futures_util::stream::unfold(self, |mut writing| async {
            let piece = writing.next().await?;
            Some((piece, writing))
        }))
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        self.end(Ended::Dropped);
    }
}

/// The request head, as the HTTP stack gave it to the router.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Seen {
    method: String,
    version: String,
    uri: String,
    path: String,
    query: Option<String>,
    /// One character for each byte of a value.
    headers: Vec<(String, String)>,
    security: &'static str,
}

/// What `Router::select` said about the head, apart from any dispatch.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "is", rename_all = "snake_case")]
enum Verdict {
    Selected {
        index: usize,
        captures: BTreeMap<String, String>,
    },
    Missed,
    Failed {
        error: String,
    },
}

/// What the target that ran knows about its request.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dispatched {
    route: String,
    /// The selection in the request's extensions. A fallback has none.
    index: Option<usize>,
    captures: BTreeMap<String, String>,
    /// The captures as the server's `Params` extractor decoded them, or its refusal.
    params: Result<BTreeMap<String, String>, String>,
    /// The request body, in base64, or why it could not be read.
    body: Result<String, String>,
    /// How far the reply's content got, for a streamed reply.
    streamed: Option<Watched>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    seen: Seen,
    verdict: Verdict,
    dispatched: Option<Dispatched>,
    status: u16,
}

pub type Ledger = Arc<Mutex<Vec<Exchange>>>;

type Routes = Router<Body, Body, Infallible>;

/// A table that is being served. Dropping it closes its listeners and connections.
pub struct Table {
    pub ledger: Ledger,
    pub streams: Arc<Streams>,
    pub ports: Ports,
    _serving: JoinSet<()>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Ports {
    /// The router behind `axum::serve`, which says nothing about transport security.
    plain: u16,
    /// The Warded Server's cleartext listener.
    http: u16,
    /// The Warded Server's HTTPS listener: HTTP/1.1, HTTP/2 and HTTP/3.
    https: u16,
}

impl Table {
    pub async fn open(definition: &Definition, tls: &Tls) -> Result<Self, String> {
        let streams = Arc::<Streams>::default();
        let routes = routes(definition, &streams)?;
        let ledger = Ledger::default();
        let app = app(routes, ledger.clone(), definition.cors);
        let mut serving = JoinSet::new();

        let plain = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(text)?;
        let plain_port = plain.local_addr().map_err(text)?.port();
        let plain_app = app.clone();
        serving.spawn(async move {
            if let Err(error) = axum::serve(plain, plain_app).await {
                eprintln!("the plain listener failed: {error}");
            }
        });

        let local = |port| SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut limits = Limits::default();
        if let Some(head_bytes) = definition.head_bytes {
            limits.head_bytes = head_bytes;
        }
        let server = Server::new(tls.clone())
            .limits(limits)
            .https(local(definition.https_port))
            .serve_http(local(0))
            .bind()
            .map_err(text)?;
        let https = server.https_addr().port();
        let http = server
            .http_addr()
            .ok_or("there is no cleartext listener")?
            .port();
        serving.spawn(async move {
            if let Err(error) = server.serve_until(app, std::future::pending()).await {
                eprintln!("the Warded Server failed: {error}");
            }
        });

        Ok(Self {
            ledger,
            streams,
            ports: Ports {
                plain: plain_port,
                http,
                https,
            },
            _serving: serving,
        })
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn routes(definition: &Definition, streams: &Arc<Streams>) -> Result<Routes, String> {
    let offers = definition
        .offers
        .iter()
        .map(|(name, set)| Ok((name.clone(), set.build().map_err(text)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut routes = Router::new();
    for target in definition
        .routes
        .iter()
        .map(|route| &route.target)
        .chain(&definition.fallback)
    {
        if target.reply.is_some() && target.lookup.is_some() {
            return Err(format!("{:?} has both a reply and a lookup", target.name));
        }
        let lookup = target.lookup.iter();
        for reply in target.reply.iter().chain(lookup.flat_map(Lookup::replies)) {
            reply
                .check()
                .map_err(|error| format!("{:?}: {error}", target.name))?;
        }
    }
    for route in &definition.routes {
        let condition = route
            .when
            .build(&offers)
            .map_err(|error| format!("route {:?}: {error}", route.target.name))?;
        let target = Arc::new(route.target.clone());
        let streams = streams.clone();
        routes = routes.route(
            condition,
            service_fn(move |request| answer(target.clone(), streams.clone(), request)),
        );
    }
    if let Some(target) = &definition.fallback {
        let target = Arc::new(target.clone());
        let streams = streams.clone();
        routes = routes.fallback(service_fn(move |request| {
            answer(target.clone(), streams.clone(), request)
        }));
    }
    Ok(routes)
}

async fn answer(
    target: Arc<Target>,
    streams: Arc<Streams>,
    request: Request,
) -> Result<Response, Infallible> {
    let (mut parts, body) = request.into_parts();
    let captures = parts
        .extensions
        .get::<Captures>()
        .map(owned)
        .unwrap_or_default();
    let params = match Params::<BTreeMap<String, String>>::from_request_parts(&mut parts, &()).await
    {
        Ok(Params(params)) => Ok(params),
        Err(rejection) => Err(rejection.to_string()),
    };
    let body = body
        .collect()
        .await
        .map(|body| BASE64_STANDARD.encode(body.to_bytes()))
        .map_err(text);
    let reply = match (&target.reply, &target.lookup) {
        (Some(reply), _) => Some(reply),
        (None, Some(lookup)) => Some(lookup.reply(params.as_ref().ok())),
        (None, None) => None,
    };
    let (response, streamed) = match reply {
        Some(reply) => {
            let (response, streamed) = reply.response(&streams);
            (Some(response), streamed)
        }
        None => (None, None),
    };
    let dispatched = Dispatched {
        route: target.name.clone(),
        index: parts
            .extensions
            .get::<Selection>()
            .map(|selection| selection.index),
        captures,
        params,
        body,
        streamed,
    };
    let mut response = match response {
        Some(response) => response,
        None => {
            let selection = serde_json::json!({
                "route": dispatched.route,
                "captures": dispatched.captures,
            });
            let mut response = Response::new(Body::from(selection.to_string()));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            response
        }
    };
    response.extensions_mut().insert(dispatched);
    Ok(response)
}

impl Reply {
    /// Refuse a reply whose content is given twice, or cannot be written.
    fn check(&self) -> Result<(), String> {
        let given = [
            !self.body.is_empty(),
            self.bytes.is_some(),
            self.stream.is_some(),
        ];
        if given.into_iter().filter(|given| *given).count() > 1 {
            return Err("a reply has one of a body, bytes and a stream".to_owned());
        }
        if let Some(bytes) = &self.bytes {
            BASE64_STANDARD.decode(bytes).map_err(text)?;
        }
        if let Some(stream) = &self.stream
            && matches!(stream.ending, Ending::Repeat)
            && stream.chunks.is_empty()
        {
            return Err("a stream that repeats needs a chunk".to_owned());
        }
        Ok(())
    }

    /// The response, and for a streamed reply, the record of how far its content gets.
    fn response(&self, streams: &Arc<Streams>) -> (Response, Option<Watched>) {
        let (body, watched) = match (&self.bytes, &self.stream) {
            (Some(bytes), _) => {
                let bytes = BASE64_STANDARD.decode(bytes).expect("checked at open");
                (Body::from(bytes), None)
            }
            (None, Some(stream)) => {
                let writing = Writing::start(stream.clone(), streams.clone());
                let watched = writing.watched.clone();
                (writing.body(), Some(watched))
            }
            (None, None) => (Body::from(self.body.clone()), None),
        };
        let mut response = Response::new(body);
        match StatusCode::from_u16(self.status) {
            Ok(status) => *response.status_mut() = status,
            Err(error) => return (problem(&error.to_string()), watched),
        }
        for (name, value) in &self.headers {
            match (name.parse::<HeaderName>(), value.parse::<HeaderValue>()) {
                (Ok(name), Ok(value)) => response.headers_mut().append(name, value),
                _ => {
                    return (
                        problem(&format!("{name:?}: {value:?} is not a header")),
                        watched,
                    );
                }
            };
        }
        (response, watched)
    }
}

/// A mistake in the test's own reply, where no test expects one.
fn problem(message: &str) -> Response {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = StatusCode::from_u16(599).expect("599 is a status");
    response
}

fn owned(captures: &Captures) -> BTreeMap<String, String> {
    captures
        .iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
}

/// The routes, as `warded_server::app` serves them, inside what records each exchange.
fn app(routes: Routes, ledger: Ledger, cors: bool) -> axum::Router {
    let recorded = warded_server::app(routes.clone())
        .layer(middleware::from_fn_with_state((routes, ledger), record));
    if cors {
        recorded.layer(middleware::from_fn(allow_pages))
    } else {
        recorded
    }
}

async fn record(
    State((routes, ledger)): State<(Routes, Ledger)>,
    request: Request,
    next: Next,
) -> Response {
    let seen = Seen::of(&request);
    let verdict = match routes.select(&Head::from_request(&request)) {
        Ok(Some(selection)) => Verdict::Selected {
            index: selection.index,
            captures: owned(&selection.captures),
        },
        Ok(None) => Verdict::Missed,
        Err(error) => Verdict::Failed {
            error: describe(&error),
        },
    };
    let response = next.run(request).await;
    ledger
        .lock()
        .expect("no holder of the ledger panics")
        .push(Exchange {
            seen,
            verdict,
            dispatched: response.extensions().get().cloned(),
            status: response.status().as_u16(),
        });
    response
}

fn describe(error: &MatchError) -> String {
    format!("{error:?}")
}

impl Seen {
    fn of(request: &Request) -> Self {
        let uri = request.uri();
        Self {
            method: request.method().to_string(),
            version: match request.version() {
                Version::HTTP_10 => "HTTP/1.0",
                Version::HTTP_11 => "HTTP/1.1",
                Version::HTTP_2 => "HTTP/2",
                Version::HTTP_3 => "HTTP/3",
                _ => "another",
            }
            .to_owned(),
            uri: uri.to_string(),
            path: uri.path().to_owned(),
            query: uri.query().map(str::to_owned),
            headers: request
                .headers()
                .iter()
                .map(|(name, value)| {
                    let value = value.as_bytes().iter().copied().map(char::from).collect();
                    (name.to_string(), value)
                })
                .collect(),
            security: match request.extensions().get() {
                Some(TransportSecurity::Https) => "https",
                Some(TransportSecurity::Unsecure) => "unsecure",
                Some(TransportSecurity::Unknown) | None => "unknown",
            },
        }
    }
}

/// CORS for a test page, outside the routes and the ledger: only real preflights are answered here,
/// so an ordinary OPTIONS request still reaches the routes.
async fn allow_pages(request: Request, next: Next) -> Response {
    let [origin, method, fields] = [
        header::ORIGIN,
        header::ACCESS_CONTROL_REQUEST_METHOD,
        header::ACCESS_CONTROL_REQUEST_HEADERS,
    ]
    .map(|name| request.headers().get(name).cloned());
    let Some(origin) = origin else {
        return next.run(request).await;
    };
    let preflight = request.method() == Method::OPTIONS && method.is_some();
    let mut response = if preflight {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        response
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("*"),
    );
    if preflight {
        if let Some(method) = method {
            headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, method);
        }
        if let Some(fields) = fields {
            headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, fields);
        }
    }
    response
}
