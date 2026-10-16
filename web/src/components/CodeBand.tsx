import { CIRCUIT_EXCERPT } from "../lib/excerpt";

/** Dark band with the real circuit source drifting behind the line. */
export function CodeBand() {
  return (
    <section className="band" aria-label="Stay unseen">
      <pre className="band-code mono" aria-hidden="true">
        {CIRCUIT_EXCERPT}
        {"\n"}
        {CIRCUIT_EXCERPT}
      </pre>
      <div className="wrap band-in">
        <p className="band-big rise">Stay unseen.</p>
        <p className="band-sub rise">
          The lines behind this sentence are from the circuit that checks every withdrawal.
        </p>
      </div>
    </section>
  );
}
