/**
 * Wallet -> pool of identical notes -> anywhere. The coin that leaves is not
 * the coin that went in, which is the whole point.
 */
export function PoolDiagram() {
  const cols = 8;
  const rows = 4;
  const notes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 330 + c * 46;
      const y = 92 + r * 46;
      const i = r * cols + c;
      notes.push(
        <g key={i} className="note" style={{ ["--i" as string]: i }} transform={`translate(${x} ${y})`}>
          <rect x={-17} y={-15} width={34} height={30} rx={8} />
          <circle cx={-7} cy={-3} r={5.2} className="eye" />
          <circle cx={7} cy={-3} r={5.2} className="eye" />
          <rect x={-13.5} y={-0.5} width={11} height={6} rx={2} className="lens" />
          <rect x={2.5} y={-0.5} width={11} height={6} rx={2} className="lens" />
          <rect x={-2.5} y={0.5} width={5} height={1.6} className="lens" />
        </g>,
      );
    }
  }
  const inPath = "M 150 170 C 220 170 250 150 300 140";
  const outA = "M 690 130 C 740 120 770 96 840 92";
  const outB = "M 690 210 C 740 220 770 246 840 250";
  return (
    <figure className="pool-fig">
      <svg viewBox="0 0 980 340" role="img" aria-labelledby="pool-title pool-desc">
        <title id="pool-title">How a shielded payment travels</title>
        <desc id="pool-desc">
          SOL leaves your wallet and becomes one of many identical notes in the pool. A payment later leaves the pool
          to any address or to a new Vision wallet, and the proof never says which note paid for it.
        </desc>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="arrowhead" />
          </marker>
        </defs>

        <g className="actor" transform="translate(30 120)">
          <rect width={120} height={100} rx={16} />
          <text x={60} y={44} textAnchor="middle" className="t-strong">
            Your wallet
          </text>
          <text x={60} y={68} textAnchor="middle" className="t-soft">
            public
          </text>
        </g>

        <path d={inPath} className="flow" markerEnd="url(#arr)" />
        <circle r={7} className="coin">
          <animateMotion dur="5.5s" repeatCount="indefinite" path={inPath} keyTimes="0;0.35;1" keyPoints="0;1;1" calcMode="linear" />
          <animate attributeName="opacity" dur="5.5s" repeatCount="indefinite" values="1;1;0;0" keyTimes="0;0.33;0.36;1" />
        </circle>

        <rect x={300} y={58} width={390} height={216} rx={26} className="pool" />
        <text x={495} y={302} textAnchor="middle" className="t-soft">
          shielded pool: every note looks the same
        </text>
        {notes}

        <path d={outA} className="flow" markerEnd="url(#arr)" />
        <path d={outB} className="flow" markerEnd="url(#arr)" />
        <circle r={7} className="coin">
          <animateMotion dur="5.5s" repeatCount="indefinite" path={outA} keyTimes="0;0.6;0.95;1" keyPoints="0;0;1;1" calcMode="linear" />
          <animate attributeName="opacity" dur="5.5s" repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;0.59;0.6;0.95;1" />
        </circle>

        <g className="actor" transform="translate(840 50)">
          <rect width={120} height={84} rx={16} />
          <text x={60} y={38} textAnchor="middle" className="t-strong">
            Any address
          </text>
          <text x={60} y={60} textAnchor="middle" className="t-soft">
            gets SOL
          </text>
        </g>
        <g className="actor accent" transform="translate(840 208)">
          <rect width={120} height={84} rx={16} />
          <text x={60} y={38} textAnchor="middle" className="t-strong">
            Vision wallet
          </text>
          <text x={60} y={60} textAnchor="middle" className="t-soft">
            buys a token
          </text>
        </g>
      </svg>
    </figure>
  );
}
