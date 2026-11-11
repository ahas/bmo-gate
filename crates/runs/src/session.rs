//! A gate asked on a provider's program (`docs/gates.md`, 「A gate on a provider's program」): one thrown-away
//! agency session started apart on the provider and the model the gate's role's order names there, and one turn
//! into it with the gate's instructions as its whole system prompt, a fresh session, no tools and thinking as the
//! run asks, waited for until it ends. A turn somebody stopped is raised; any other end with no answer is the
//! gate having none.

use gate_ports::agency::{Apart, GateTurn, Line, TurnEnd};

use crate::records::{Outcome, Spent};
use crate::{Ended, GateError, Run, Runs};

fn unanswered(outcome: Outcome, why: impl Into<String>) -> Ended {
  Ended::Unanswered {
    outcome,
    why: why.into(),
  }
}

/// How a turn's end reads as the gate's: its answer with the model that gave it and what it spent, a stop
/// raised, or no answer with why.
pub fn ended(end: TurnEnd, mapped: &str) -> Result<Ended, GateError> {
  let failure_kind = end
    .failure
    .as_ref()
    .and_then(|failure| failure.get("kind"))
    .and_then(|kind| kind.as_str())
    .map(str::to_owned);

  if end.outcome == "stopped" || failure_kind.as_deref() == Some("stopped") {
    return Err(GateError::Stopped(end.reason.unwrap_or_else(|| "the run was stopped".to_owned())));
  }

  let answer = end.answer.as_deref().map(str::trim).filter(|answer| !answer.is_empty());

  match (end.outcome.as_str(), answer) {
    ("answered", Some(answer)) => {
      let model = end
        .went_out
        .as_ref()
        .and_then(|went| went.model.clone())
        .or_else(|| {
          end
            .reply
            .as_ref()
            .and_then(|reply| reply.get("model"))
            .and_then(|model| model.as_str())
            .map(str::to_owned)
        })
        .unwrap_or_else(|| mapped.to_owned());
      let spend = end
        .reply
        .as_ref()
        .and_then(|reply| reply.get("spend"))
        .and_then(|spend| spend.as_array())
        .cloned()
        .unwrap_or_default();

      Ok(Ended::Answered {
        text: answer.to_owned(),
        model,
        spent: Spent::of_spend(&spend),
      })
    }
    ("answered", None) => Ok(unanswered(Outcome::Error, "the turn answered nothing")),
    (outcome, _) => {
      let why = end.reason.unwrap_or_else(|| failure_kind.unwrap_or_else(|| outcome.to_owned()));

      Ok(unanswered(Outcome::Error, format!("the turn ended {outcome}: {why}")))
    }
  }
}

/// The run's one turn in a thrown-away session of its provider's program.
pub async fn ask(runs: &Runs, run: &Run<'_>) -> Result<Ended, GateError> {
  let request = run.request;
  let route = run.route;
  let Some(mapping) = &route.mapping else {
    return Ok(unanswered(Outcome::Unavailable, "its provider serves it nothing now"));
  };
  let model = route.model().to_owned();

  // The run's session stands under the gate's own agent where the settings name one, its program's place kept
  // apart from the agent whose turn it judges; otherwise the caller's agent, and the stage's name where it names
  // none.
  let agent = runs
    .run_agent
    .clone()
    .or_else(|| request.agent.clone())
    .unwrap_or_else(|| run.stage.to_owned());
  let apart = Apart {
    provider: route.provider.clone(),
    model: model.clone(),
    cwd: runs.session_folder.clone(),
  };
  let session = match runs.agency.start_apart(&agent, &apart).await {
    Err(why) => return Ok(unanswered(Outcome::Error, format!("its session would not stand: {why}"))),
    Ok(session) => session,
  };
  let turn = GateTurn {
    session: session.id,
    prompt: request.material(),
    provider: route.provider.clone(),
    model: model.clone(),
    mapping: Line {
      model: model.clone(),
      effort: mapping.effort.clone(),
      answer_tokens: mapping.answer_tokens,
    },
    name: run.name.clone(),
    gate: run.route.gate.clone(),
    chat: request.chat_id,
    system: request.system.clone(),
    thinking: request.thinking,
  };

  match runs.agency.turn(&turn).await {
    Err(why) => Ok(unanswered(Outcome::Error, why.to_string())),
    Ok(end) => ended(end, &model),
  }
}
