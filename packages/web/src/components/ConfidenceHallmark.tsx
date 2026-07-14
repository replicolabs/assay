import type { ConfidenceBucket } from "../../../gateway/src/api/contracts";

const LABELS: Record<ConfidenceBucket, string> = {
  unproven: "Unproven",
  emerging: "Emerging",
  proven: "Proven",
  high_confidence: "High Confidence"
};

/**
 * The hallmark: a stamped mark, not a meter. Each confidence bucket gets a
 * distinct visual weight — from a faint dashed outline (unproven) to a
 * solid, embossed bronze disc (high_confidence) — so trust reads the way an
 * assay office's stamp does: pressed into the record, not scored out of 100.
 */
export function ConfidenceHallmark({ bucket }: { bucket: ConfidenceBucket }) {
  return (
    <div
      className={`hallmark hallmark--${bucket}`}
      role="img"
      aria-label={`Confidence: ${LABELS[bucket]}`}
      title={`Confidence: ${LABELS[bucket]}`}
    >
      <span className="hallmark__label">{LABELS[bucket]}</span>
    </div>
  );
}
