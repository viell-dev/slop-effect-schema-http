//! Route conditions as the tests write them, and the Warded matchers they stand for.
//!
//! Each variant is named after the function of `warded` that it calls, so a test reads like a route
//! table. The host adds no routing rule of its own, except for the two conditions that Warded leaves
//! to applications: [`Condition::Host`], copied from Warded's guide to custom matchers, and the
//! predicates of [`Condition::Filter`].

use serde::Deserialize;
use std::collections::BTreeMap;
use warded_server::axum::http::{Method, Version, header::HOST, uri::Authority};
use warded_server::warded::{
    DefinitionError, Head, Matcher, match_fn,
    matchers::{self, SecurityMatcher},
    negotiation::{self, LanguageMatching, Offers},
};

/// Any condition, as a route table holds it.
pub type Boxed = Box<dyn Matcher + Send + Sync>;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Lookup,
    BasicFilter,
}

impl From<Mode> for LanguageMatching {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Lookup => Self::Lookup,
            Mode::BasicFilter => Self::BasicFilter,
        }
    }
}

/// The alternatives that some routes of one table share.
#[derive(Debug, Deserialize)]
#[serde(tag = "field", rename_all = "snake_case")]
pub enum OfferSet {
    MediaTypes { values: Vec<String> },
    Languages { values: Vec<String>, mode: Mode },
    Encodings { values: Vec<String> },
}

impl OfferSet {
    pub fn build(&self) -> Result<Offers, DefinitionError> {
        match self {
            Self::MediaTypes { values } => Offers::media_types(values),
            Self::Languages { values, mode } => Offers::languages(values, (*mode).into()),
            Self::Encodings { values } => Offers::encodings(values),
        }
    }
}

/// What `filter` asks of a captured value. Warded hands it the raw text.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Predicate {
    /// One or more ASCII digits that fit in a `u64`.
    Number,
    /// ASCII letters, digits and underscores, starting with a letter.
    Username,
}

impl Predicate {
    fn holds(self, raw: &str) -> bool {
        match self {
            Self::Number => {
                raw.bytes().all(|byte| byte.is_ascii_digit()) && raw.parse::<u64>().is_ok()
            }
            Self::Username => {
                raw.starts_with(|first: char| first.is_ascii_alphabetic())
                    && raw
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "is", rename_all = "snake_case")]
pub enum Condition {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Connect,
    Trace,
    Query,
    Method {
        method: String,
    },
    Version {
        version: String,
    },
    Secured {
        unknown_as_miss: bool,
    },
    Unsecure {
        unknown_as_miss: bool,
    },
    SecuredPost,
    SecuredGetAndHead,
    ExactPath {
        path: String,
    },
    Path {
        pattern: String,
    },
    HeaderEq {
        name: String,
        value: String,
    },
    HeaderAnyEq {
        name: String,
        value: String,
    },
    HeaderPresent {
        name: String,
    },
    ParamPair {
        key: String,
        value: String,
    },
    ParamPresent {
        key: String,
    },
    AcceptsMediaType {
        offer: String,
    },
    AcceptsLanguage {
        offer: String,
        mode: Mode,
    },
    AcceptsEncoding {
        offer: String,
    },
    Selected {
        offers: String,
        offer: String,
        invalid_is_error: bool,
    },
    Host {
        host: String,
    },
    And {
        of: Vec<Condition>,
    },
    Or {
        of: Vec<Condition>,
    },
    Not {
        of: Box<Condition>,
    },
    Filter {
        of: Box<Condition>,
        capture: String,
        test: Predicate,
    },
}

impl Condition {
    /// The matcher this condition describes, or why it describes none.
    pub fn build(&self, offers: &BTreeMap<String, Offers>) -> Result<Boxed, String> {
        Ok(match self {
            Self::Get => Box::new(matchers::get()),
            Self::Head => Box::new(matchers::head()),
            Self::Post => Box::new(matchers::post()),
            Self::Put => Box::new(matchers::put()),
            Self::Patch => Box::new(matchers::patch()),
            Self::Delete => Box::new(matchers::delete()),
            Self::Options => Box::new(matchers::options()),
            Self::Connect => Box::new(matchers::connect()),
            Self::Trace => Box::new(matchers::trace()),
            Self::Query => Box::new(matchers::query()),
            Self::Method { method } => Box::new(matchers::method(
                Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?,
            )),
            Self::Version { version } => Box::new(matchers::version(http_version(version)?)),
            Self::Secured { unknown_as_miss } => {
                Box::new(security(matchers::secured(), *unknown_as_miss))
            }
            Self::Unsecure { unknown_as_miss } => {
                Box::new(security(matchers::unsecure(), *unknown_as_miss))
            }
            Self::SecuredPost => Box::new(matchers::secured_post()),
            Self::SecuredGetAndHead => Box::new(matchers::secured_get_and_head()),
            Self::ExactPath { path } => Box::new(matchers::exact_path(path)),
            Self::Path { pattern } => Box::new(matchers::path(pattern).map_err(definition)?),
            Self::HeaderEq { name, value } => {
                Box::new(matchers::header_eq(name, latin1(value)?).map_err(definition)?)
            }
            Self::HeaderAnyEq { name, value } => {
                Box::new(matchers::header_any_eq(name, latin1(value)?).map_err(definition)?)
            }
            Self::HeaderPresent { name } => {
                Box::new(matchers::header_present(name).map_err(definition)?)
            }
            Self::ParamPair { key, value } => Box::new(matchers::param_pair(key, value)),
            Self::ParamPresent { key } => Box::new(matchers::param_present(key)),
            Self::AcceptsMediaType { offer } => {
                Box::new(negotiation::accepts_media_type(offer).map_err(definition)?)
            }
            Self::AcceptsLanguage { offer, mode } => {
                Box::new(negotiation::accepts_language(offer, (*mode).into()).map_err(definition)?)
            }
            Self::AcceptsEncoding { offer } => {
                Box::new(negotiation::accepts_encoding(offer).map_err(definition)?)
            }
            Self::Selected {
                offers: set,
                offer,
                invalid_is_error,
            } => {
                let set = offers
                    .get(set)
                    .ok_or_else(|| format!("no offer set {set:?}"))?;
                let selected = set.selected(offer).map_err(definition)?;
                Box::new(if *invalid_is_error {
                    selected.invalid_is_error()
                } else {
                    selected
                })
            }
            Self::Host { host } => {
                let host = host.clone();
                Box::new(match_fn(move |head| host_is(head, &host)))
            }
            Self::And { of } => combine(of, offers, |left, right| Box::new(left.and(right)))?,
            Self::Or { of } => combine(of, offers, |left, right| Box::new(left.or(right)))?,
            Self::Not { of } => Box::new(of.build(offers)?.not()),
            Self::Filter { of, capture, test } => {
                let (capture, test) = (capture.clone(), *test);
                Box::new(of.build(offers)?.filter(move |captures| {
                    captures.get(&capture).is_some_and(|raw| test.holds(raw))
                }))
            }
        })
    }
}

fn combine(
    conditions: &[Condition],
    offers: &BTreeMap<String, Offers>,
    join: fn(Boxed, Boxed) -> Boxed,
) -> Result<Boxed, String> {
    let mut built = conditions.iter().map(|condition| condition.build(offers));
    let first = built
        .next()
        .ok_or("a combination needs at least one condition")??;
    built.try_fold(first, |left, right| Ok(join(left, right?)))
}

fn definition(error: DefinitionError) -> String {
    error.to_string()
}

fn security(matcher: SecurityMatcher, unknown_as_miss: bool) -> SecurityMatcher {
    if unknown_as_miss {
        matcher.unknown_as_miss()
    } else {
        matcher
    }
}

fn http_version(text: &str) -> Result<Version, String> {
    match text {
        "HTTP/1.0" => Ok(Version::HTTP_10),
        "HTTP/1.1" => Ok(Version::HTTP_11),
        "HTTP/2" => Ok(Version::HTTP_2),
        "HTTP/3" => Ok(Version::HTTP_3),
        other => Err(format!("no HTTP version {other:?}")),
    }
}

/// Header values cross from JavaScript with one character for each byte.
fn latin1(text: &str) -> Result<Vec<u8>, String> {
    text.chars()
        .map(|character| u8::try_from(u32::from(character)))
        .collect::<Result<_, _>>()
        .map_err(|_| format!("{text:?} has a character that is not one byte"))
}

/// `host_is` of Warded's guide to custom matchers, unchanged.
fn host_is(head: &Head<'_>, expected: &str) -> bool {
    if let Some(authority) = head.uri().authority() {
        return authority.host().eq_ignore_ascii_case(expected);
    }
    // Without an authority in the URI, HTTP/1.1 requires exactly one Host field.
    let mut fields = head.headers().get_all(HOST).iter();
    match (fields.next(), fields.next()) {
        (Some(field), None) => field
            .to_str()
            .ok()
            .and_then(|value| value.parse::<Authority>().ok())
            .is_some_and(|authority| authority.host().eq_ignore_ascii_case(expected)),
        _ => false,
    }
}
