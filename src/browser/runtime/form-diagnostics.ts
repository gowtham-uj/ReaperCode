/**
 * Why a form rejected the value, answered by the browser rather than guessed.
 *
 * The failure this replaces is specific and expensive. A registration form
 * refused a username, the page gave no reason beyond "invalid", and the agent's
 * response was to try another username. And another. It had nothing to read, so
 * it searched a space that had an answer in the markup the whole time: the input
 * carried `maxlength="20"` and the value it was submitting was thirty-one
 * characters long.
 *
 * That information is not hidden. It is in the element's attributes and in the
 * Constraint Validation API, both of which the browser has already computed
 * before the form was ever submitted. `input.validity.tooLong` is true, and
 * `input.validationMessage` says "Please shorten this text to 20 characters or
 * fewer". One `evaluate` against the field answers a question the agent spent
 * turns on.
 *
 * So this reads it, and the important part is that it reads it *before* the
 * guess rather than after the rejection. A model that inspects a form before
 * filling it does not make the guess at all.
 *
 * ## When the browser is not the reason
 *
 * A server can reject a value the browser considers perfectly valid: a username
 * already taken, a password that fails a policy the client was never told. No
 * client-side read can see that, which is why this distinguishes the two. When
 * validity is clean and the server still refuses, the answer is to probe
 * deliberately rather than to randomise: a bounded series of values, each one
 * tried once, so the search is structured and ends.
 */

import type { Locator, Page } from "playwright";

/** What the browser says about one field. */
export interface FieldDiagnostics {
  /** The field's name or id, as the page labels it. */
  name: string;
  /** The input's type: text, email, number, password. */
  type: string;
  /** What the browser would report if the form were submitted now. */
  valid: boolean;
  /** Whether the field must be filled. */
  required: boolean;
  /** The length constraints, when the markup declares them. */
  minLength?: number;
  maxLength?: number;
  /** The pattern the value must match, as source. */
  pattern?: string;
  /** The current value's length, which is what usually explains a rejection. */
  valueLength: number;
  /** The constraint validation flags, named as the browser names them. */
  validity: Record<string, boolean>;
  /** The browser's own sentence, when it has one. */
  validationMessage?: string;
}

/**
 * Read every field in a form, or one field.
 *
 * One `evaluate` for the whole form rather than one per field, because a
 * registration form has eight inputs and eight round trips to answer one
 * question is the kind of overhead this whole layer exists to remove.
 */
export async function inspectForm(
  page: Page,
  form: Locator | undefined,
): Promise<{ fields: FieldDiagnostics[]; invalid: string[] }> {
  const scope = form ?? page.locator("form").first();
  const raw = await scope
    .evaluate((element: Element) => {
      const node = element as HTMLFormElement;
      const fields: Array<Record<string, unknown>> = [];
      const elements = node.querySelectorAll("input, select, textarea");
      for (const field of Array.from(elements)) {
        const input = field as HTMLInputElement;
        /*
         * Hidden and submit inputs carry no constraint information worth
         * reading, and listing them makes the answer longer without making it
         * more useful. A hidden csrf field is not something the model should be
         * reasoning about.
         */
        if (input.type === "hidden" || input.type === "submit" || input.type === "button") continue;
        const validity = input.validity as unknown as Record<string, boolean>;
        fields.push({
          name: input.name || input.id || input.getAttribute("aria-label") || "(unnamed)",
          type: input.type,
          valid: input.checkValidity(),
          required: input.required,
          minLength: input.minLength >= 0 ? input.minLength : null,
          maxLength: input.maxLength >= 0 ? input.maxLength : null,
          pattern: input.getAttribute("pattern"),
          valueLength: input.value.length,
          /*
           * Only the flags that are true, because ValidityState always reports
           * every flag and a record of twelve falses is noise around the one
           * true.
           */
          validity: Object.fromEntries(Object.entries(validity).filter(([, value]) => value === true)),
          validationMessage: input.validationMessage || null,
        });
      }
      return fields;
    })
    .catch(() => [] as Array<Record<string, unknown>>);

  const fields = raw.map((entry) => shape(entry));
  return { fields, invalid: fields.filter((field) => !field.valid).map((field) => field.name) };
}

/** Coerce the page's raw object into the declared shape without trusting it. */
function shape(raw: Record<string, unknown>): FieldDiagnostics {
  const num = (value: unknown): number | undefined => (typeof value === "number" && value >= 0 ? value : undefined);
  const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
  const validity =
    raw.validity !== null && typeof raw.validity === "object" ? (raw.validity as Record<string, boolean>) : {};
  return {
    name: typeof raw.name === "string" ? raw.name : "(unnamed)",
    type: typeof raw.type === "string" ? raw.type : "text",
    valid: raw.valid === true,
    required: raw.required === true,
    ...(num(raw.minLength) !== undefined ? { minLength: num(raw.minLength)! } : {}),
    ...(num(raw.maxLength) !== undefined ? { maxLength: num(raw.maxLength)! } : {}),
    ...(str(raw.pattern) !== undefined ? { pattern: str(raw.pattern)! } : {}),
    valueLength: num(raw.valueLength) ?? 0,
    validity,
    ...(str(raw.validationMessage) !== undefined ? { validationMessage: str(raw.validationMessage)! } : {}),
  };
}

/**
 * A bounded series of values to try, when the browser sees nothing wrong.
 *
 * Only produced for the case where validity is clean, which is the case a client
 * cannot diagnose. The values step through the lengths a server is most likely
 * to accept rather than being random: eight, sixteen, twenty-four characters,
 * which covers the thresholds that actually appear in password and username
 * policies.
 *
 * There is no fifth attempt. A bounded probe that runs out is a better answer
 * than an unbounded one that does not, because the model gets told to stop and
 * spend its steps elsewhere rather than continuing to guess.
 */
export function probeValues(base: string): string[] {
  const clean = base.replace(/[^a-zA-Z0-9]/g, "") || "value";
  return [8, 16, 24].map((length) => {
    const stem = clean.slice(0, Math.max(1, length - 4));
    return `${stem}${String(length).padStart(4, "0").slice(-4)}`.slice(0, length);
  });
}

/** The form's diagnostics as the model reads them. */
export function renderFormDiagnostics(result: { fields: FieldDiagnostics[]; invalid: string[] }): string {
  if (result.fields.length === 0) return "FORM: no fillable fields found in this form.";
  const lines = [`FORM: ${result.fields.length} fields, ${result.invalid.length} currently invalid`];
  for (const field of result.fields) {
    const limits: string[] = [];
    if (field.required) limits.push("required");
    if (field.maxLength !== undefined) limits.push(`max ${field.maxLength}`);
    if (field.minLength !== undefined) limits.push(`min ${field.minLength}`);
    if (field.pattern !== undefined) limits.push(`pattern ${field.pattern}`);
    const suffix = limits.length > 0 ? ` (${limits.join(", ")})` : "";
    /*
     * An invalid field gets its reason on its own line, because that is the
     * answer the model came for and burying it in a comma-separated list is how
     * the original bug happened.
     */
    if (!field.valid) {
      const flags = Object.keys(field.validity).join(", ") || "invalid";
      lines.push(`  ${field.name} [${field.type}]${suffix} INVALID: ${flags}`);
      if (field.validationMessage !== undefined) lines.push(`      ${field.validationMessage}`);
      if (field.valueLength > 0) lines.push(`      current value is ${field.valueLength} characters`);
    } else {
      lines.push(`  ${field.name} [${field.type}]${suffix} ok`);
    }
  }
  return lines.join("\n");
}
