//! One test's route table: its routes, its listeners, and what reached it.

use crate::condition::{Condition, OfferSet};
use base64::{Engine, prelude::BASE64_STANDARD};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinSet};
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

/// What a selected route answers. Without a `reply`, the selection itself, as JSON.
#[derive(Clone, Debug, Deserialize)]
struct Target {
    name: String,
    reply: Option<Reply>,
}

#[derive(Clone, Debug, Deserialize)]
struct Reply {
    status: u16,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: String,
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
        let routes = routes(definition)?;
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

fn routes(definition: &Definition) -> Result<Routes, String> {
    let offers = definition
        .offers
        .iter()
        .map(|(name, set)| Ok((name.clone(), set.build().map_err(text)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut routes = Router::new();
    for route in &definition.routes {
        let condition = route
            .when
            .build(&offers)
            .map_err(|error| format!("route {:?}: {error}", route.target.name))?;
        let target = Arc::new(route.target.clone());
        routes = routes.route(
            condition,
            service_fn(move |request| answer(target.clone(), request)),
        );
    }
    if let Some(target) = &definition.fallback {
        let target = Arc::new(target.clone());
        routes = routes.fallback(service_fn(move |request| answer(target.clone(), request)));
    }
    Ok(routes)
}

async fn answer(target: Arc<Target>, request: Request) -> Result<Response, Infallible> {
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
    let dispatched = Dispatched {
        route: target.name.clone(),
        index: parts
            .extensions
            .get::<Selection>()
            .map(|selection| selection.index),
        captures,
        params,
        body,
    };
    let mut response = match &target.reply {
        Some(reply) => reply.response(),
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
    fn response(&self) -> Response {
        let mut response = Response::new(Body::from(self.body.clone()));
        match StatusCode::from_u16(self.status) {
            Ok(status) => *response.status_mut() = status,
            Err(error) => return problem(&error.to_string()),
        }
        for (name, value) in &self.headers {
            match (name.parse::<HeaderName>(), value.parse::<HeaderValue>()) {
                (Ok(name), Ok(value)) => response.headers_mut().append(name, value),
                _ => return problem(&format!("{name:?}: {value:?} is not a header")),
            };
        }
        response
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
