import type { EvidenceSummary } from "../../../gateway/src/api/contracts";

const VARIANCE_LABEL: Record<EvidenceSummary["consistency_variance"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  unknown: "Unknown"
};

/** A delta is only worth calling out visually once it's large enough to matter. */
const DRIFT_THRESHOLD = 5;

function EvidenceLine({
  label,
  value,
  warn = false
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  const isNull = value === "—";
  return (
    <div className="evidence-line">
      <span className="evidence-line__label">{label}</span>
      <span className="evidence-line__leader" aria-hidden="true" />
      <span
        className={
          "evidence-line__value" +
          (isNull ? " evidence-line__value--null" : "") +
          (warn ? " evidence-line__value--warn" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The receipts: every line here is a source a claim in fit_reasoning can be
 * traced back to. Nothing in CandidateCard should assert something this
 * panel doesn't back up.
 */
export function EvidencePanel({ evidence }: { evidence: EvidenceSummary }) {
  const {
    canary_score_this_category,
    tasks_completed_this_category,
    disputes_against,
    consistency_variance,
    divergence_flag,
    recent_vs_historical_delta
  } = evidence;

  const hasDrift =
    recent_vs_historical_delta !== null && Math.abs(recent_vs_historical_delta) >= DRIFT_THRESHOLD;

  return (
    <div className="evidence-panel">
      <p className="evidence-panel__title">Evidence</p>

      <EvidenceLine
        label="Canary score, this category"
        value={canary_score_this_category === null ? "—" : `${canary_score_this_category} / 100`}
      />
      <EvidenceLine
        label="Tasks completed, this category"
        value={String(tasks_completed_this_category)}
      />
      <EvidenceLine
        label="Disputes against"
        value={String(disputes_against)}
        warn={disputes_against > 0}
      />
      <EvidenceLine
        label="Consistency variance"
        value={VARIANCE_LABEL[consistency_variance]}
        warn={consistency_variance === "high"}
      />

      {hasDrift && recent_vs_historical_delta !== null && (
        <div className="callout">
          <span className="callout__mark" aria-hidden="true">
            △
          </span>
          <span>
            Drift detected — recent performance is{" "}
            {recent_vs_historical_delta > 0 ? "up" : "down"}{" "}
            {Math.abs(recent_vs_historical_delta).toFixed(1)} points vs. this agent&rsquo;s historical
            average.
          </span>
        </div>
      )}

      {divergence_flag && (
        <div className="callout">
          <span className="callout__mark" aria-hidden="true">
            ⚠
          </span>
          <span>Sources disagree — independent evaluation runs did not converge on this rating.</span>
        </div>
      )}
    </div>
  );
}
