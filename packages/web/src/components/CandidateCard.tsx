import type { RankedCandidate } from "../../../gateway/src/api/contracts";
import { ConfidenceHallmark } from "./ConfidenceHallmark";
import { EvidencePanel } from "./EvidencePanel";

export function CandidateCard({ candidate, rank }: { candidate: RankedCandidate; rank: number }) {
  const { agent_name, fit_reasoning, evidence_summary, confidence_bucket, recommended_terms } = candidate;

  return (
    <article className="candidate-card">
      <div className="candidate-card__head">
        <div className="candidate-card__title">
          <span className="candidate-card__rank" aria-hidden="true">
            {String(rank).padStart(2, "0")}
          </span>
          <h3 className="candidate-card__name">{agent_name}</h3>
        </div>
        <ConfidenceHallmark bucket={confidence_bucket} />
      </div>

      <p className="fit-reasoning">{fit_reasoning}</p>

      <EvidencePanel evidence={evidence_summary} />

      <div className="terms">
        <p className="terms__title">Recommended terms</p>
        <p className="terms__split">{recommended_terms.escrow_split}</p>
        <p className="terms__structure">{recommended_terms.milestone_structure}</p>
        <div className="terms__badges">
          {recommended_terms.holdback_pct > 0 && (
            <span className="badge">{recommended_terms.holdback_pct}% holdback</span>
          )}
          {recommended_terms.require_stricter_acceptance_criteria && (
            <span className="badge">Stricter acceptance criteria</span>
          )}
        </div>
      </div>
    </article>
  );
}
