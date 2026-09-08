# Production Evidence

Apply this pattern whenever a candidate or artifact is claimed ready for
production acceptance. It is reusable across products, platforms, packaging,
generated outputs, signing, and release routes. It defines evidence and review
ownership; it does not add product, deployment, or external-enforcement policy.

## Claim levels

- **Local/unit confidence**: Fixtures, unit tests, and focused local checks can
  prove bounded logic or contract behavior. They cannot by themselves justify
  production acceptance.
- **Production acceptance**: Requires the evidence below and an explicit Lead
  decision. Production evidence means the real production route, artifact, and
  consumer; it does not necessarily require a production deployment.

## Required evidence

1. **Actual producer and path.** Exercise the actual production producer/path
   with the real production configuration and input boundary for the claim. A
   local exercise is sufficient when it uses that route and produces the exact
   candidate consumed by the actual consumer; do not silently replace it with a
   fixture or test-only path.
2. **Exact identity.** Preserve the exact candidate or artifact and record a
   deterministic identity, such as a content digest and immutable snapshot or
   path/version, so the Lead can inspect the same bytes.
3. **Consumer and provenance.** Trace producer inputs and contracts through
   generation, packaging, and signing steps as applicable, through the artifact
   to the actual consumer and its provenance chain. State which consumer used
   the candidate.
4. **Strict shared contract.** Where producer and consumer share a contract,
   use one strict shared contract/validator for both and identify what it
   validates. Make test-only dependencies explicit and keep them outside
   self-attested artifact data; they cannot supply the production proof.
5. **Both proof directions.** Provide positive proof for the allowed route and
   targeted negative proof that fails for the intended reason, with the relevant
   contract or diagnostic visible. Keep negative proof isolated and recoverable.
6. **Fixture limits.** Fixtures may exercise local or unit logic, including
   contract behavior, but cannot substitute for the production producer, exact
   artifact, actual consumer, or their provenance evidence.
7. **Lead decision.** The Lead checks the exact bytes or snapshot and the
   production call path, then explicitly records `ACCEPTS` or `REJECTS` with a
   reason. A handback, status update, or green test suite is not acceptance.

## Report and enforcement

Report the exact evidence, production configuration and input boundary,
candidate/artifact identity, producer path, actual consumer, provenance chain,
positive and negative results, limitations, unattempted live or external gates,
and enforcement level. State enforcement levels separately:

- **Local validation:** name the command or inspection and its observed result.
- **Optional hook:** state whether a convenience hook exists; do not imply it is
  required.
- **CI:** state whether a checked-in workflow invokes the relevant check and
  report a run only when it was observed; source presence is not execution.
- **Branch protection:** state whether required checks or merge blocking were
  verified externally; otherwise report them as unverified.

This documentation does not create automated CI enforcement, hooks, branch
protection, or any other externally observable policy. A separate Human
decision is required before adding such enforcement.
