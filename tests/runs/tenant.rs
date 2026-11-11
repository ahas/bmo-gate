//! A run's company (docs/boundary-api.md, 「How a gate run reaches a model」): a run that names its tenant sends its
//! material led by a mark made from that name, so runs for different companies share no prompt prefix; the mark
//! says nothing of the name, and a run that names none sends its prompt as it stands.

use gate_runs::{GateRequest, tenant_mark};

fn request(tenant: Option<&str>) -> GateRequest {
  let mut request = GateRequest::new("the gate's instructions", "the room's words");

  request.tenant = tenant.map(str::to_owned);
  request
}

#[test]
fn a_runs_material_is_led_by_its_companys_mark_and_by_nothing_where_it_names_none() {
  let first = request(Some("company-1")).material();
  let second = request(Some("company-2")).material();

  assert!(first.starts_with(&tenant_mark("company-1")), "{first}");
  assert!(first.ends_with("\nthe room's words"), "{first}");
  assert_ne!(first.lines().next(), second.lines().next());
  assert!(!first.contains("company-1"), "the mark says nothing of the name: {first}");
  assert_eq!(request(None).material(), "the room's words");

  // A part of a cut request keeps its company.
  assert!(
    request(Some("company-1"))
      .part("one part")
      .material()
      .starts_with(&tenant_mark("company-1"))
  );
}
