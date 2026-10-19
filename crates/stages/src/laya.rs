//! The one road every gate takes past Laya (`docs/laya.md`, 「Modes」, 「The client」): a gate's probe makes its
//! input into Laya's questions, the client asks them of the gate's own relay at the address its settings name with
//! the token its file holds, one call of this service at a time within the gate's own wait, and the gate's mode
//! decides whether Laya's verdict may stand, and the pair of Laya's answer and the LLM's is kept for teaching it.
//! It knows no gate by name: what a probe asks and what a verdict means are the probe's.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use std::path::PathBuf;

use gate_policy::profiles::PROFILES;
use gate_runs::GateError;
use gate_runs::options;
use gate_runs::records::now;
use sea_orm::DatabaseConnection;
use sha2::{Digest, Sha256};

use crate::Stages;
use crate::ordered::Ordered;
use crate::sql::run;

// What one question may carry, the part of it kept for the question, and what the state beside it may take.
const MAX_TOKENS: usize = 1_024;
const QUESTION_TOKENS: usize = 256;
const STATE_TOKENS: usize = MAX_TOKENS - QUESTION_TOKENS;

/// The most questions one call takes.
pub const QUESTIONS_PER_CALL: usize = 128;

// The most input one call is sent with.
const TOKENS_PER_CALL: usize = 32_768;

// The most an answer may run to.
const MAX_ANSWER_BYTES: usize = 256 * 1_024;

/// Why Laya gave no answer, in the words the record keeps.
pub type Failure = &'static str;

/// One question as a gate asks it.
#[derive(Clone, Debug)]
pub enum Question {
  Noul {
    instructions: String,
  },
  Choice {
    instructions: String,
    criteria: Ordered,
  },
  Score {
    instructions: String,
    criteria: Ordered,
  },
}

impl Question {
  fn kind(&self) -> &'static str {
    match self {
      Self::Noul { .. } => "noul",
      Self::Choice { .. } => "choice",
      Self::Score { .. } => "score",
    }
  }

  fn instructions(&self) -> &str {
    match self {
      Self::Noul { instructions }
      | Self::Choice { instructions, .. }
      | Self::Score { instructions, .. } => instructions,
    }
  }

  fn criteria(&self) -> Option<&Ordered> {
    match self {
      Self::Noul { .. } => None,
      Self::Choice { criteria, .. } | Self::Score { criteria, .. } => Some(criteria),
    }
  }

  fn ordered(&self) -> Ordered {
    let mut fields = vec![
      ("type", Ordered::text(self.kind())),
      ("instructions", Ordered::text(self.instructions())),
    ];

    if let Some(criteria) = self.criteria() {
      fields.push(("criteria", criteria.clone()));
    }

    Ordered::map(fields)
  }

  fn tokens(&self) -> usize {
    let criteria = self
      .criteria()
      .map(|criteria| serde_json::to_string(criteria).unwrap_or_default())
      .unwrap_or_default();

    estimated_tokens(&format!("{}{criteria}", self.instructions()))
  }
}

/// A gate's request: the state its questions are about, and the questions by id in their order.
#[derive(Clone, Debug)]
pub struct Request {
  pub state: Ordered,
  pub questions: Vec<(String, Question)>,
}

impl Request {
  /// The request as Laya and the record read it.
  pub fn ordered(&self) -> Ordered {
    Ordered::map([
      ("state", self.state.clone()),
      (
        "questions",
        Ordered::map(self.questions.iter().map(|(id, question)| (id.clone(), question.ordered()))),
      ),
    ])
  }

  fn state_text(&self) -> String {
    state_text(&self.state)
  }

  /// Whether the request fits the checkpoint: the state beside each question, and each question inside the
  /// part kept for it.
  pub fn fits(&self) -> bool {
    estimated_tokens(&self.state_text()) <= STATE_TOKENS
      && self.questions.iter().all(|(_, question)| question.tokens() <= QUESTION_TOKENS)
  }

  /// The request as the calls that carry it, each with the whole state.
  pub fn parts(&self) -> Vec<Request> {
    let state = estimated_tokens(&self.state_text());
    let mut parts = vec![];
    let mut taken: Vec<(String, Question)> = vec![];
    let mut tokens = 0;

    for (id, question) in &self.questions {
      let cost = state + question.tokens();

      if taken.len() == QUESTIONS_PER_CALL || (!taken.is_empty() && tokens + cost > TOKENS_PER_CALL) {
        parts.push(Request {
          state: self.state.clone(),
          questions: std::mem::take(&mut taken),
        });
        tokens = 0;
      }

      taken.push((id.clone(), question.clone()));
      tokens += cost;
    }

    if !taken.is_empty() {
      parts.push(Request {
        state: self.state.clone(),
        questions: taken,
      });
    }

    parts
  }
}

/// One answer as its question asked for it.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
  Noul {
    noul: f64,
    confidence: f64,
  },
  Choice {
    choice: String,
    probabilities: Vec<(String, f64)>,
    confidence: f64,
  },
  Score {
    score: f64,
    probabilities: Vec<(String, f64)>,
    confidence: f64,
  },
}

/// A number as JavaScript writes one: a whole one with no fraction.
pub fn number(value: f64) -> Ordered {
  if value.fract() == 0.0 && value.abs() < 1e15 {
    return Ordered::Number((value as i64).into());
  }

  serde_json::Number::from_f64(value).map_or(Ordered::Null, Ordered::Number)
}

impl Answer {
  fn ordered(&self) -> Ordered {
    let probabilities = |given: &[(String, f64)]| {
      Ordered::map(given.iter().map(|(key, value)| (key.clone(), number(*value))))
    };

    match self {
      Self::Noul { noul, confidence } => Ordered::map([
        ("type", Ordered::text("noul")),
        ("noul", number(*noul)),
        ("confidence", number(*confidence)),
      ]),
      Self::Choice {
        choice,
        probabilities: given,
        confidence,
      } => Ordered::map([
        ("type", Ordered::text("choice")),
        ("choice", Ordered::text(choice)),
        ("probabilities", probabilities(given)),
        ("confidence", number(*confidence)),
      ]),
      Self::Score {
        score,
        probabilities: given,
        confidence,
      } => Ordered::map([
        ("type", Ordered::text("score")),
        ("score", number(*score)),
        ("probabilities", probabilities(given)),
        ("confidence", number(*confidence)),
      ]),
    }
  }
}

/// Laya's answers to every question of a request, and what the whole of it took from here.
#[derive(Clone, Debug)]
pub struct Reply {
  pub answers: Vec<(String, Answer)>,
  pub ms: f64,
}

impl Reply {
  fn ordered(&self) -> Ordered {
    Ordered::map(self.answers.iter().map(|(id, answer)| (id.clone(), answer.ordered())))
  }

  /// The answer to one question.
  pub fn answer(&self, id: &str) -> Option<&Answer> {
    self.answers.iter().find(|(given, _)| given == id).map(|(_, answer)| answer)
  }
}

/// What Laya's answers come to: a label and how sure Laya is of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
  pub label: String,
  pub confidence: f64,
}

/// One yes/no: the label for yes or for no, as sure as the answer is.
pub fn noul_reading(reply: &Reply, id: &str, yes: &str, no: &str) -> Result<Reading, Failure> {
  match reply.answer(id) {
    Some(Answer::Noul { noul, .. }) => Ok(Reading {
      label: if *noul >= 0.5 { yes } else { no }.to_owned(),
      confidence: noul.max(1.0 - noul),
    }),
    _ => Err("bad-answer"),
  }
}

/// A generous count of what the checkpoint's tokenizer makes of a text: a character outside ASCII as one
/// token, and about three ASCII characters to a token.
pub fn estimated_tokens(text: &str) -> usize {
  let (ascii, other) = text.chars().fold((0_usize, 0_usize), |(ascii, other), character| {
    if u32::from(character) < 128 { (ascii + 1, other) } else { (ascii, other + 1) }
  });

  (other as f64 + ascii as f64 * 0.35).ceil() as usize
}

// The calls this service sends go one at a time.
static LINE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(tokio::sync::Mutex::default);

fn probability(value: Option<&serde_json::Value>) -> Option<f64> {
  value.and_then(serde_json::Value::as_f64).filter(|value| (0.0..=1.0).contains(value))
}

fn probabilities(value: Option<&serde_json::Value>) -> Option<Vec<(String, f64)>> {
  let given = value?.as_object()?;
  let read: Option<Vec<(String, f64)>> = given
    .iter()
    .map(|(key, value)| probability(Some(value)).map(|value| (key.clone(), value)))
    .collect();

  read.filter(|read| !read.is_empty())
}

// One answer in the shape its question asked for, or none.
fn answer_for(question: &Question, value: Option<&serde_json::Value>) -> Option<Answer> {
  let answer = value?.as_object()?;

  if answer.get("type").and_then(serde_json::Value::as_str) != Some(question.kind()) {
    return None;
  }

  let confidence = probability(answer.get("confidence"))?;

  match question {
    Question::Noul { .. } => Some(Answer::Noul {
      noul: probability(answer.get("noul"))?,
      confidence,
    }),
    Question::Choice { criteria, .. } => {
      let given = probabilities(answer.get("probabilities"))?;
      let options: Vec<String> = match criteria {
        Ordered::List(list) => list.iter().filter_map(|one| one.as_text().map(str::to_owned)).collect(),
        Ordered::Map(map) => map.keys().cloned().collect(),
        _ => vec![],
      };
      let choice = answer.get("choice").and_then(serde_json::Value::as_str)?;
      let same = given.len() == options.len()
        && options.iter().all(|option| given.iter().any(|(key, _)| key == option));

      (options.iter().any(|option| option == choice) && same).then(|| Answer::Choice {
        choice: choice.to_owned(),
        probabilities: given,
        confidence,
      })
    }
    Question::Score { .. } => Some(Answer::Score {
      score: answer.get("score").and_then(serde_json::Value::as_f64)?,
      probabilities: probabilities(answer.get("probabilities"))?,
      confidence,
    }),
  }
}

/// The server's own word for a question too large, a held call, a service unable to take one, an answer gone
/// wrong, or a refusal.
pub fn failure_of(status: u16, text: &str) -> Failure {
  match status {
    400 if text.contains("head_max_len") => "too-large",
    504 => "timeout",
    503 => "unreachable",
    500.. => "bad-answer",
    _ => "refused",
  }
}

async fn ask_part(
  url: &str,
  token: &str,
  gate: &str,
  part: &Request,
  until: Instant,
) -> Result<Vec<(String, Answer)>, Failure> {
  let remaining = until
    .checked_duration_since(Instant::now())
    .filter(|left| !left.is_zero())
    .ok_or("timeout")?;
  let mut body = Ordered::map([("gate", Ordered::text(gate))]);

  if let (Ordered::Map(fields), Ordered::Map(request)) = (&mut body, part.ordered()) {
    fields.extend(request);
  }

  let client = reqwest::Client::builder().timeout(remaining).build().map_err(|_| "unreachable")?;
  let answer = client
    .post(format!("{url}/decide"))
    .bearer_auth(token)
    .header("content-type", "application/json")
    .body(serde_json::to_string(&body).unwrap_or_default())
    .send()
    .await
    .map_err(|why| if why.is_timeout() { "timeout" } else { "unreachable" })?;
  let status = answer.status().as_u16();
  let text = answer
    .text()
    .await
    .map_err(|why| if why.is_timeout() { "timeout" } else { "unreachable" })?;

  if !(200..300).contains(&status) {
    return Err(failure_of(status, &text));
  }

  if text.len() > MAX_ANSWER_BYTES {
    return Err("bad-answer");
  }

  let read: serde_json::Value = serde_json::from_str(&text).map_err(|_| "bad-answer")?;
  let given = read.get("answers").filter(|given| given.is_object()).ok_or("bad-answer")?;

  part
    .questions
    .iter()
    .map(|(id, question)| {
      answer_for(question, given.get(id))
        .map(|answer| (id.clone(), answer))
        .ok_or("bad-answer")
    })
    .collect()
}

/// What a question to Laya is asked with, held whole so a question asked beside a gate's run may outlive the
/// caller's borrow: the gate's database, the relay's address, the file its token stands in, and the chat agent
/// whose options a gate's mode and wait are read from.
#[derive(Clone)]
pub struct Side {
  db: DatabaseConnection,
  url: Option<String>,
  token_file: Option<PathBuf>,
  chat_agent: String,
}

impl Side {
  /// The side of a service whose settings name the relay at `url`, with no slash after it, and its token's file;
  /// a service naming no address runs every gate on its LLM alone.
  pub fn new(
    db: DatabaseConnection,
    url: Option<&str>,
    token_file: Option<PathBuf>,
    chat_agent: impl Into<String>,
  ) -> Self {
    Self {
      db,
      url: url.map(|url| url.trim().trim_end_matches('/').to_owned()).filter(|url| !url.is_empty()),
      token_file,
      chat_agent: chat_agent.into(),
    }
  }

  /// Whether Laya is to be asked at all.
  pub fn configured(&self) -> bool {
    self.url.is_some()
  }

  /// The relay's address, where the settings name one.
  pub fn url(&self) -> Option<&str> {
    self.url.as_deref()
  }

  /// The token, read afresh from its file, so a token replaced needs no restart.
  pub fn token(&self) -> Option<String> {
    self.token_file.as_deref().and_then(crate::laya_health::token)
  }
}

/// Laya's answer to every question of the request, or why there is none: a request that does not fit is not
/// sent, its parts go into the line in order, and the gate's wait covers the line and every part.
pub async fn ask(side: &Side, gate: &str, request: &Request, wait: Duration) -> Result<Reply, Failure> {
  if request.questions.is_empty() || !request.fits() {
    return Err("too-large");
  }

  let url = side.url.clone().ok_or("unreachable")?;
  let token = side.token().ok_or("refused")?;
  let started = Instant::now();
  let until = started + wait;
  let mut answers = vec![];

  for part in request.parts() {
    let Ok(_turn) = tokio::time::timeout_at(until.into(), LINE.lock()).await else {
      return Err("timeout");
    };

    answers.extend(ask_part(&url, &token, gate, &part, until).await?);
  }

  Ok(Reply {
    answers,
    ms: started.elapsed().as_secs_f64() * 1_000.0,
  })
}

/// What a gate's probe makes of its input and of what Laya and its LLM said.
pub trait Probe: Clone + Send + Sync + 'static {
  type Input: Clone + Send + Sync + 'static;
  /// What the gate decides: a verdict Laya's label stands for, or its model's.
  type Verdict: Clone + Send + Sync + 'static;

  /// The state and questions this input asks Laya, or why it cannot be asked.
  fn question(&self, input: &Self::Input) -> Result<Request, Failure>;
  /// What Laya's answers come to.
  fn read(&self, reply: &Reply) -> Result<Reading, Failure>;
  /// The gate's verdict Laya's label stands for, or none where Laya may not settle it alone.
  fn verdict_of(&self, label: &str) -> Option<Self::Verdict>;
  /// The LLM's verdict as a label comparable with Laya's.
  fn label_of(&self, verdict: &Self::Verdict) -> String;
  /// What a label says each question should have been answered, as the record teaches it.
  fn truth_of(&self, label: &str, request: &Request) -> Option<Ordered>;
  /// The verdict safe to let Laya settle alone, for a gate filtered asymmetrically.
  fn safe_label(&self) -> Option<&str>;
  /// For a probe whose questions are each a verdict of their own (docs/laya.md, 「A gate settled one question
  /// at a time」), the input narrowed to some of its questions; none for a probe settled whole.
  fn narrow(&self, _input: &Self::Input, _ids: &[String]) -> Option<Self::Input> {
    None
  }
  /// The verdict joined out of the part Laya settled and the LLM's on the rest.
  fn join(&self, _laya: Self::Verdict, llm: Self::Verdict) -> Self::Verdict {
    llm
  }
}

/// What a caller is told of a pair as it is kept: the label Laya came to, where it came to one, and the request
/// it was asked, so the caller may keep its own side of each question beside it.
pub type PairKept =
  Arc<dyn Fn(Option<String>, Option<Request>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Which gate run this is: the gate whose options and record it takes, what it judged, who is told of each
/// pair it keeps, and whether it keeps any: a run over words that are written down nowhere keeps none.
#[derive(Clone)]
pub struct LayaRun {
  pub stage: String,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  pub subject: Option<String>,
  pub kept: Option<PairKept>,
  pub keeps_pairs: bool,
}

impl LayaRun {
  /// A run of a gate about a room's message, which tells nobody of its pairs.
  pub fn of(stage: &str, chat_id: Option<i64>, message_id: Option<i64>) -> Self {
    Self {
      stage: stage.to_owned(),
      chat_id,
      message_id,
      subject: None,
      kept: None,
      keeps_pairs: true,
    }
  }
}

// How a question to Laya ended: its request, and its answer read or its failure.
#[derive(Clone)]
enum Asked {
  Answered {
    request: Request,
    reply: Reply,
    reading: Reading,
  },
  Failed {
    request: Option<Request>,
    failure: Failure,
    ms: Option<f64>,
  },
}

impl Asked {
  fn request(&self) -> Option<&Request> {
    match self {
      Self::Answered { request, .. } => Some(request),
      Self::Failed { request, .. } => request.as_ref(),
    }
  }
}

// The mode a gate actually runs in and its τ, as the chat agent's options row and the gate's profile make it.
async fn mode_of(side: &Side, stage: &str) -> Result<(String, Option<f64>), GateError> {
  let Some(profile) = PROFILES.of(stage) else {
    return Ok(("off".to_owned(), None));
  };
  let row = options::row(&side.db, stage, &side.chat_agent)
    .await
    .map_err(|why| GateError::Fault(why.to_string()))?
    .unwrap_or_default();

  Ok((options::effective_mode(profile, row.laya_mode.as_deref(), row.laya_tau), row.laya_tau))
}

async fn ask_for<P: Probe>(side: &Side, run: &LayaRun, probe: &P, input: &P::Input) -> Asked {
  let started = Instant::now();
  let request = match probe.question(input) {
    Ok(request) => request,
    Err(failure) => {
      return Asked::Failed {
        request: None,
        failure,
        ms: None,
      };
    }
  };
  let wait = match options::timeout_ms(&side.db, &run.stage, &side.chat_agent).await {
    Ok(Some(wait)) => Duration::from_millis(wait.max(0) as u64),
    _ => {
      eprintln!("Laya probe failed: {} has no time limit to run on", run.stage);
      return Asked::Failed {
        request: Some(request),
        failure: "bad-answer",
        ms: Some(started.elapsed().as_secs_f64() * 1_000.0),
      };
    }
  };

  match ask(side, &run.stage, &request, wait).await {
    Ok(reply) => match probe.read(&reply) {
      Ok(reading) => Asked::Answered {
        request,
        reply,
        reading,
      },
      Err(failure) => Asked::Failed {
        request: Some(request),
        failure,
        ms: Some(reply.ms),
      },
    },
    Err(failure) => Asked::Failed {
      request: Some(request),
      failure,
      ms: Some(started.elapsed().as_secs_f64() * 1_000.0),
    },
  }
}

// The verdict Laya's answer may stand for in this mode at this τ, or none where the LLM decides.
fn standing<P: Probe>(probe: &P, mode: &str, tau: Option<f64>, asked: &Asked) -> Option<P::Verdict> {
  let Asked::Answered { reading, .. } = asked else { return None };
  let tau = tau?;

  if reading.confidence < tau {
    return None;
  }

  if mode == "asymmetric" && probe.safe_label() != Some(reading.label.as_str()) {
    return None;
  }

  (mode == "filter" || mode == "asymmetric")
    .then(|| probe.verdict_of(&reading.label))
    .flatten()
}

// Laya's answer to some of the questions it was asked, as if those had been all of them; a reading the probe
// cannot make of them is Laya giving no answer to those questions.
fn part_of<P: Probe>(probe: &P, asked: &Asked, ids: &[String]) -> Asked {
  let Asked::Answered { request, reply, .. } = asked else {
    return asked.clone();
  };
  let pick = |id: &String| request.questions.iter().find(|(given, _)| given == id).cloned();
  let request = Request {
    state: request.state.clone(),
    questions: ids.iter().filter_map(pick).collect(),
  };
  let reply = Reply {
    answers: ids
      .iter()
      .filter_map(|id| reply.answers.iter().find(|(given, _)| given == id).cloned())
      .collect(),
    ms: reply.ms,
  };

  match probe.read(&reply) {
    Ok(reading) => Asked::Answered {
      request,
      reply,
      reading,
    },
    Err(_) => Asked::Failed {
      ms: Some(reply.ms),
      request: Some(request),
      failure: "bad-answer",
    },
  }
}

// Where a probe settled one question at a time divides: the questions whose own answer stands at τ, as Laya's
// part of the verdict, and the rest, left to the LLM. None where no question stands, or every one does and
// the whole answer still did not.
struct Split<V> {
  laya: Asked,
  settled: V,
  rest: Vec<String>,
  left: Asked,
}

fn split_at<P: Probe>(probe: &P, mode: &str, tau: Option<f64>, asked: &Asked) -> Option<Split<P::Verdict>> {
  let Asked::Answered { request, .. } = asked else { return None };
  let ids: Vec<String> = request.questions.iter().map(|(id, _)| id.clone()).collect();
  let stands: Vec<String> = ids
    .iter()
    .filter(|id| standing(probe, mode, tau, &part_of(probe, asked, std::slice::from_ref(id))).is_some())
    .cloned()
    .collect();
  let rest: Vec<String> = ids.iter().filter(|id| !stands.contains(id)).cloned().collect();

  if stands.is_empty() || rest.is_empty() {
    return None;
  }

  let laya = part_of(probe, asked, &stands);
  let settled = standing(probe, mode, tau, &laya)?;
  let left = part_of(probe, asked, &rest);

  Some(Split {
    laya,
    settled,
    rest,
    left,
  })
}

// The pair kept for teaching Laya: what was asked, what Laya said, what the LLM said, which was used, and
// why Laya's answer was of no use where the caller found it of none. Whoever the run tells of its pairs is
// told once it is kept.
#[allow(clippy::too_many_arguments)]
async fn record<P: Probe>(
  db: &DatabaseConnection,
  judged: &LayaRun,
  probe: &P,
  mode: &str,
  asked: &Asked,
  llm: Option<&P::Verdict>,
  used: &str,
  failed: Option<Failure>,
) {
  if !judged.keeps_pairs {
    return;
  }

  let request = asked.request();
  let input = request.map_or_else(
    || "{}".to_owned(),
    |request| serde_json::to_string(&request.ordered()).unwrap_or_default(),
  );
  let hashed = request.map(|_| input.as_str()).unwrap_or_default();
  let llm_label = llm.map(|verdict| probe.label_of(verdict));
  let laya_label = match asked {
    Asked::Answered { reading, .. } => Some(reading.label.clone()),
    Asked::Failed { .. } => None,
  };
  let truth = match (&llm_label, request) {
    (Some(label), Some(request)) => probe
      .truth_of(label, request)
      .map(|truth| serde_json::to_string(&truth).unwrap_or_default()),
    _ => None,
  };
  let safe = |label: &Option<String>| match (probe.safe_label(), label) {
    (Some(safe), Some(label)) => Some(i64::from(label == safe)),
    _ => None,
  };
  let (laya, confidence, ms, failure) = match asked {
    Asked::Answered { reply, reading, .. } => (
      Some(serde_json::to_string(&reply.ordered()).unwrap_or_default()),
      Some(reading.confidence),
      Some(reply.ms),
      None,
    ),
    Asked::Failed { failure, ms, .. } => (None, None, *ms, Some(*failure)),
  };
  let failure = failed.or(failure);
  let written = run(
    db,
    r#"INSERT INTO "laya_verdicts" ("stage", "chat_id", "message_id", "subject", "input_hash", "input", "laya", "confidence",
         "llm_verdict", "llm_answers", "laya_verdict", "laya_safe", "llm_safe", "mode", "used", "ms", "failure", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)"#,
    vec![
      judged.stage.as_str().into(),
      judged.chat_id.into(),
      judged.message_id.into(),
      judged.subject.clone().into(),
      format!("{:x}", Sha256::digest(hashed.as_bytes())).into(),
      input.into(),
      laya.into(),
      confidence.into(),
      llm_label.clone().into(),
      truth.into(),
      laya_label.clone().into(),
      safe(&laya_label).into(),
      safe(&llm_label).into(),
      mode.into(),
      used.into(),
      ms.into(),
      failure.map(str::to_owned).into(),
      now().into(),
    ],
  )
  .await;

  if let Err(why) = written {
    eprintln!("{}: Laya pair could not be recorded: {why}", judged.stage);
  }

  if let Some(kept) = &judged.kept {
    kept(laya_label, request.cloned()).await;
  }
}

/// A gate's verdict by way of Laya where its mode lets it: off, its LLM alone; shadow, its LLM with Laya
/// asked beside it and the pair kept; filter or asymmetric, Laya's verdict where it stands at τ and the LLM's
/// otherwise — for a probe settled one question at a time, Laya's on the questions that stand and the LLM's on
/// the rest, asked of it alone. `llm` runs the gate on the input it is handed, and what it raises — a stop
/// above all — goes on to the caller untouched.
pub async fn judge_with_laya<P, F, Fut>(
  stages: &Stages,
  run: &LayaRun,
  probe: &P,
  input: &P::Input,
  llm: F,
) -> Result<Option<P::Verdict>, GateError>
where
  P: Probe,
  F: FnOnce(P::Input) -> Fut,
  Fut: Future<Output = Result<Option<P::Verdict>, GateError>>,
{
  let side = stages.laya.clone();
  let (mode, tau) = mode_of(&side, &run.stage).await?;

  if mode == "off" || side.url.is_none() {
    return llm(input.clone()).await;
  }

  if mode == "shadow" {
    // Laya is asked at the same time and the gate never waits for it: the pair is kept once both have
    // settled, by a task of its own.
    let (sent, answered) = tokio::sync::oneshot::channel::<Option<P::Verdict>>();
    let (run_of, probe_of, input_of) = (run.clone(), probe.clone(), input.clone());
    let task = tokio::spawn(async move {
      let asked = ask_for(&side, &run_of, &probe_of, &input_of).await;

      if let Ok(verdict) = answered.await {
        record(&side.db, &run_of, &probe_of, "shadow", &asked, verdict.as_ref(), "llm", None).await;
      }
    });

    SHADOWS.lock().expect("the shadow pairs").push(task);

    let verdict = llm(input.clone()).await;

    // A stop or a failure past Laya leaves no pair: there is no LLM verdict to set beside it.
    if let Ok(verdict) = &verdict {
      let _ = sent.send(verdict.clone());
    }

    return verdict;
  }

  let asked = ask_for(&side, run, probe, input).await;

  if let Some(settled) = standing(probe, &mode, tau, &asked) {
    record(&side.db, run, probe, &mode, &asked, None, "laya", None).await;

    return Ok(Some(settled));
  }

  if let Some(split) = split_at(probe, &mode, tau, &asked)
    && let Some(narrowed) = probe.narrow(input, &split.rest)
  {
    record(&side.db, run, probe, &mode, &split.laya, None, "laya", None).await;

    let verdict = llm(narrowed).await?;

    record(&side.db, run, probe, &mode, &split.left, verdict.as_ref(), "llm", None).await;

    return Ok(verdict.map(|verdict| probe.join(split.settled, verdict)));
  }

  let verdict = llm(input.clone()).await?;

  record(&side.db, run, probe, &mode, &asked, verdict.as_ref(), "llm", None).await;

  Ok(verdict)
}

/// Who settled a gate on Laya: Laya, its fallback LLM where Laya gave no verdict, or the gate's own default
/// where neither did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecidedBy {
  Laya,
  Llm,
  Default,
}

/// What a gate on Laya decided, with the Laya failure that left it to the other two.
#[derive(Clone, Debug)]
pub struct RoadVerdict<V> {
  pub verdict: V,
  pub failure: Option<Failure>,
  pub ms: Option<f64>,
  pub decided_by: DecidedBy,
}

/// A gate whose provider is Laya (docs/laya.md, 「A gate whose provider is Laya」): one call, whose label is
/// the verdict whatever its confidence. Where Laya gives none — any failure, a label the probe cannot turn
/// into a verdict, no address set — the gate's fallback LLM is asked once by `llm`, which runs the gate as
/// that LLM on the whole input, unless the gate's row leaves it none; where it gives none either, `fallback`
/// stands. The pair is kept either way, and what `llm` raises — a stop above all — goes on to the caller once
/// it is.
pub async fn judge_on_laya<P, F, Fut>(
  stages: &Stages,
  run: &LayaRun,
  probe: &P,
  input: &P::Input,
  fallback: P::Verdict,
  llm: F,
) -> Result<RoadVerdict<P::Verdict>, GateError>
where
  P: Probe,
  F: FnOnce(P::Input) -> Fut,
  Fut: Future<Output = Result<Option<P::Verdict>, GateError>>,
{
  let side = stages.laya.clone();
  let asked = if side.url.is_some() {
    ask_for(&side, run, probe, input).await
  } else {
    Asked::Failed {
      request: None,
      failure: "unreachable",
      ms: None,
    }
  };
  let verdict = match &asked {
    Asked::Answered { reading, .. } => probe.verdict_of(&reading.label),
    Asked::Failed { .. } => None,
  };
  let failure = match &asked {
    Asked::Answered { .. } => verdict.is_none().then_some("bad-answer"),
    Asked::Failed { failure, .. } => Some(*failure),
  };
  let falls_back = verdict.is_none() && options::laya_fallback(&stages.runs, &run.stage).await?.is_some();
  let answered = if falls_back { llm(input.clone()).await } else { Ok(None) };
  let llm_verdict = answered.as_ref().ok().cloned().flatten();
  let used = if llm_verdict.is_some() { "llm" } else { "laya" };

  record(&side.db, run, probe, "road", &asked, llm_verdict.as_ref(), used, failure).await;
  answered?;

  if verdict.is_none() {
    match llm_verdict {
      None => eprintln!(
        "{}: Laya gave no verdict ({}), so the gate's default stands.",
        run.stage,
        failure.unwrap_or_default()
      ),
      Some(_) => eprintln!(
        "{}: Laya gave no verdict ({}), so its fallback LLM decided.",
        run.stage,
        failure.unwrap_or_default()
      ),
    }
  }

  let decided_by = match (&verdict, &llm_verdict) {
    (Some(_), _) => DecidedBy::Laya,
    (None, Some(_)) => DecidedBy::Llm,
    (None, None) => DecidedBy::Default,
  };
  let ms = match &asked {
    Asked::Answered { reply, .. } => Some(reply.ms),
    Asked::Failed { ms, .. } => *ms,
  };

  Ok(RoadVerdict {
    verdict: verdict.or(llm_verdict).unwrap_or(fallback),
    failure,
    ms,
    decided_by,
  })
}

/// The label of a set of members Laya said yes to: their names in order, or the word for none.
pub const NONE_LABEL: &str = "none";

pub fn set_label(members: &[String]) -> String {
  if members.is_empty() {
    return NONE_LABEL.to_owned();
  }

  let mut sorted = members.to_vec();

  sorted.sort();
  sorted.join(",")
}

/// One yes/no per member, read as the set of members Laya said yes to, only as sure as its least sure member.
pub fn set_reading(reply: &Reply, members: &[(String, String)]) -> Result<Reading, Failure> {
  let mut chosen = vec![];
  let mut confidence: f64 = 1.0;

  for (id, member) in members {
    let reading = noul_reading(reply, id, "yes", "no")?;

    if reading.label == "yes" {
      chosen.push(member.clone());
    }

    confidence = confidence.min(reading.confidence);
  }

  Ok(Reading {
    label: set_label(&chosen),
    confidence,
  })
}

fn state_text(state: &Ordered) -> String {
  match state {
    Ordered::Text(text) => text.clone(),
    other => serde_json::to_string(other).unwrap_or_default(),
  }
}

fn state_fits(state: &Ordered) -> bool {
  estimated_tokens(&state_text(state)) <= STATE_TOKENS
}

// The longest opening of a text that fits, by its characters.
fn opening_that_fits(text: &str, fits: impl Fn(&str) -> bool) -> String {
  let characters: Vec<char> = text.chars().collect();
  let (mut low, mut high) = (0, characters.len());

  while low < high {
    let middle = (low + high).div_ceil(2);

    if fits(&characters[..middle].iter().collect::<String>()) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  characters[..low].iter().collect()
}

/// A text as Laya is asked it (docs/laya.md, 「Fitting an input」): whole where the state `state_of` makes of
/// it fits, or its opening cut to what fits.
pub fn fit_text(text: &str, state_of: impl Fn(&str) -> Ordered) -> String {
  let fits = |kept: &str| state_fits(&state_of(kept));

  if fits(text) { text.to_owned() } else { opening_that_fits(text, fits) }
}

/// A transcript as Laya is asked it: its newest whole messages whose state fits, the oldest the first to stay
/// out, or the newest one's opening where not even it fits alone.
pub fn fit_messages(messages: &[String], state_of: impl Fn(&[String]) -> Ordered) -> Vec<String> {
  let fits = |kept: &[String]| state_fits(&state_of(kept));
  let mut from = messages.len();

  while from > 0 && fits(&messages[from - 1..]) {
    from -= 1;
  }

  if from < messages.len() || messages.is_empty() {
    return messages[from..].to_vec();
  }

  let newest = &messages[messages.len() - 1];

  vec![fit_text(newest, |cut| state_of(&[cut.to_owned()]))]
}

/// A question inside the part kept for it: an overlong one keeps its opening, where its fixed wording stands.
pub fn fit_question(question: Question) -> Question {
  if question.tokens() <= QUESTION_TOKENS {
    return question;
  }

  let with = |instructions: &str| match &question {
    Question::Noul { .. } => Question::Noul {
      instructions: instructions.to_owned(),
    },
    Question::Choice { criteria, .. } => Question::Choice {
      instructions: instructions.to_owned(),
      criteria: criteria.clone(),
    },
    Question::Score { criteria, .. } => Question::Score {
      instructions: instructions.to_owned(),
      criteria: criteria.clone(),
    },
  };
  let kept = opening_that_fits(question.instructions(), |cut| with(cut).tokens() <= QUESTION_TOKENS);

  with(&kept)
}

// The pairs a shadow question is still to keep, which a service ending on purpose waits for.
static SHADOWS: LazyLock<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>> =
  LazyLock::new(Default::default);

/// Every shadow pair still being asked kept before a service that is ending goes: a command that runs one gate
/// and ends waits here.
pub async fn settled() {
  let tasks: Vec<_> = SHADOWS.lock().expect("the shadow pairs").drain(..).collect();

  for task in tasks {
    let _ = task.await;
  }
}
