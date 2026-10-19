//! A gate asked on a registered model (`docs/boundary-api.md`, 「The model gateway」): one request with no tools
//! to the registration its mapping names, through the agency's gateway, with the gate's thinking and answer room
//! on that road, its sampling, and what is left of its wait. A request the gateway refuses as past the
//! registration's window is too large; a wait that ran out is a timeout; anything else unanswered is an error.

use gate_policy::profiles::PROFILES;
use gate_ports::PortError;
use gate_ports::gateway::Ask;

use crate::records::{Outcome, Spent};
use crate::{Ended, GateError, Run, Runs, options};

/// Whether a gateway's refusal says the request is past the model's window: a refused request naming the
/// context, or a maximum and then tokens.
pub fn says_too_large(complaint: &str) -> bool {
  let complaint = complaint.to_lowercase();

  complaint.contains("context")
    || complaint.find("maximum").is_some_and(|at| complaint[at..].contains("tokens"))
}

fn unanswered(outcome: Outcome, why: impl Into<String>) -> Ended {
  Ended::Unanswered {
    outcome,
    why: why.into(),
  }
}

/// The run's one request through the gateway.
pub async fn ask(runs: &Runs, run: &Run<'_>) -> Result<Ended, GateError> {
  let stage = run.stage;
  let Some(mapping) = &run.route.mapping else {
    return Ok(unanswered(Outcome::Unavailable, "its provider serves it nothing now"));
  };
  let Some(model) = mapping.model.clone().filter(|model| !model.is_empty()) else {
    return Ok(unanswered(Outcome::Unavailable, "its tier maps to no registration"));
  };
  let left = run.left();

  if left.is_zero() {
    return Ok(unanswered(Outcome::Timeout, "its wait ran out before the request went out"));
  }

  let sampling = PROFILES
    .of(stage)
    .and_then(|profile| profile.sampling.as_ref())
    .filter(|sampling| !sampling.is_empty())
    .and_then(|sampling| serde_json::to_string(sampling).ok());
  let ask = Ask {
    model: model.clone(),
    system: run.request.system.clone(),
    input: run.request.prompt.clone(),
    max_tokens: options::answer_room(stage, Some(mapping)),
    thinking: options::thinks_on(mapping),
    wait: left,
    sampling,
  };
  let answered = tokio::time::timeout_at(run.deadline, runs.gateway.complete(&ask)).await;
  let timed_out = run.left().is_zero();

  Ok(match answered {
    Err(_) => unanswered(Outcome::Timeout, "its wait ran out"),
    Ok(Ok(completion)) => match completion.text.map(|text| text.trim().to_owned()) {
      Some(text) if !text.is_empty() => Ended::Answered {
        text,
        model,
        spent: Spent::of_usage(completion.usage.as_ref()),
      },
      _ => unanswered(Outcome::Error, "the gateway answered nothing"),
    },
    Ok(Err(PortError::Refused {
      status: 400, error, ..
    }))
      if says_too_large(&error) =>
    {
      unanswered(Outcome::TooLarge, "past the registration's window")
    }
    Ok(Err(PortError::Refused { status: 408, .. })) => {
      unanswered(Outcome::Timeout, "the gateway's wait ran out")
    }
    Ok(Err(failure)) if timed_out => unanswered(Outcome::Timeout, failure.to_string()),
    Ok(Err(failure)) => unanswered(Outcome::Error, failure.to_string()),
  })
}
