import type { Assessment } from "../../../gateway/src/api/contracts";
import { CandidateCard } from "./CandidateCard";

export function ShortlistView({ assessment }: { assessment: Assessment }) {
  const { candidates, task_summary } = assessment;

  return (
    <section aria-labelledby="shortlist-heading">
      <div className="shortlist-header">
        <h2 id="shortlist-heading">Shortlist</h2>
        <span className="count">
          {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="shortlist-summary">
        Ranked for: <em>&ldquo;{task_summary}&rdquo;</em>
      </p>

      {candidates.length === 0 ? (
        <div className="empty-state">No candidates cleared assay for this task yet.</div>
      ) : (
        <div className="shortlist">
          {candidates.map((candidate, i) => (
            <CandidateCard key={candidate.agent_id} candidate={candidate} rank={i + 1} />
          ))}
        </div>
      )}
    </section>
  );
}
