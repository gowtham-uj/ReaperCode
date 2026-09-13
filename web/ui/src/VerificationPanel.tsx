import type { VerificationSurface } from "@reaper/web-shared";

function toneOf(verification: VerificationSurface): "verified" | "claimed" | "failed" {
  if (!verification.ok) return "failed";
  return verification.verified ? "verified" : "claimed";
}

export function VerificationPanel({ verification }: { verification: VerificationSurface | undefined }) {
  if (!verification) return null;
  const failureClasses = verification.failureClasses ?? [];
  const feedback = verification.feedback ?? [];
  return (
    <section className="verification" data-tone={toneOf(verification)} aria-label="Verification verdict">
      <div className="verification-head">
        <span className="verification-glyph" aria-hidden="true">
          {verification.ok ? (verification.verified ? "✓" : "~") : "✗"}
        </span>
        <span className="verification-verdict">
          {verification.ok ? (verification.verified ? "Verified" : "Passed, unverified") : "Failed"}
        </span>
        {verification.attemptCount !== undefined && (
          <span className="verification-attempts">
            {verification.attemptCount} attempt{verification.attemptCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {verification.command && <code className="verification-command">{verification.command}</code>}
      {verification.groundedSignal && (
        <p className="verification-signal">
          Grounded by {verification.groundedSignal.kind}: <code>{verification.groundedSignal.command}</code>
        </p>
      )}
      {!verification.verified && verification.ok && (
        <p className="verification-warning" role="note">
          Exit 0 without a real test, build, or typecheck signal does not verify the result.
        </p>
      )}
      {failureClasses.length > 0 && (
        <div className="verification-classes">
          {failureClasses.map((failureClass) => <span className="verification-class" data-tone="failed" key={failureClass}>{failureClass}</span>)}
        </div>
      )}
      {verification.selfDebugExplanation && <details className="verification-detail"><summary>Self-debug</summary><p>{verification.selfDebugExplanation}</p></details>}
      {verification.diffReviewExplanation && <details className="verification-detail"><summary>Diff review</summary><p>{verification.diffReviewExplanation}</p></details>}
      {feedback.length > 0 && (
        <details className="verification-detail">
          <summary>Feedback ({feedback.length})</summary>
          <ul className="verification-feedback">{feedback.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
