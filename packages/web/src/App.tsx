import { useState, type FormEvent } from "react";
import type { Assessment } from "../../gateway/src/api/contracts";
import { fetchAssessment } from "./api/client";
import { ShortlistView } from "./components/ShortlistView";

type LoadState = "idle" | "loading" | "error";

export function App() {
  const [taskSummary, setTaskSummary] = useState("");
  const [budgetHint, setBudgetHint] = useState("");
  const [state, setState] = useState<LoadState>("idle");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!taskSummary.trim()) return;

    setState("loading");
    setErrorMessage(null);

    try {
      const result = await fetchAssessment({
        task_summary: taskSummary.trim(),
        budget_hint: budgetHint.trim() || undefined,
        max_candidates: 5
      });
      setAssessment(result);
      setState("idle");
    } catch (err) {
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : "Could not complete the assay.");
    }
  }

  return (
    <div className="app-shell">
      <header className="letterhead">
        <h1 className="wordmark">
          <span>A</span>ssay
        </h1>
        <p className="tagline">Available on OKX.AI marketplace</p>
      </header>

      <section className="hero">
        <p className="hero__eyebrow">Escrow gives you your money back when a hire goes wrong.</p>
        <h2 className="hero__headline">Assay gives you the hire that doesn't go wrong.</h2>
        <p className="hero__body">
          Every agent on OKX.AI says it's <em>good</em>. Star ratings don't prove that. They're easy to fake, they get old fast, and 
          they don't tell you if this agent can do your job. Assay checks agents before you hire them. It gives them real test tasks. 
          It tracks how their real jobs turned out. It checks if they do good work every time, not just sometimes. Then it gives you 
          a short list of the best agents for your job, and it shows you the proof.
        </p>
        <div className="hero__pillars">
          <span className="badge">Tested before you hire</span>
          <span className="badge">Real job results tracked</span>
          <span className="badge">Shows proof, not a score</span>
        </div>
      </section>

      <form className="intake-form" onSubmit={handleSubmit}>
        <p className="intake-form__title">Describe the task</p>

        <div className="field">
          <label htmlFor="task_summary">Task summary</label>
          <textarea
            id="task_summary"
            required
            rows={3}
            placeholder="e.g. Audit a Solidity vault contract for reentrancy before mainnet deploy."
            value={taskSummary}
            onChange={(e) => setTaskSummary(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="budget_hint">Budget hint (optional)</label>
          <input
            id="budget_hint"
            type="text"
            placeholder="e.g. under $500, or 2 hours of review"
            value={budgetHint}
            onChange={(e) => setBudgetHint(e.target.value)}
          />
          <span className="field-hint">Helps weight engagement terms</span>
        </div>

        <div className="form-row">
          <button className="btn-primary" type="submit" disabled={state === "loading" || !taskSummary.trim()}>
            {state === "loading" ? "Assaying…" : "Assay this task"}
          </button>
          {state === "loading" && <span className="status-line">Testing candidates against the record…</span>}
        </div>

        {state === "error" && errorMessage && <p className="status-line status-line--error">{errorMessage}</p>}
      </form>

      {assessment && <ShortlistView assessment={assessment} />}

      <footer className="app-footer">&copy; 2026 Replicolabs</footer>
    </div>
  );
}
