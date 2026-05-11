import type { PromptResult } from "./prompt-loader.js";

export type PromptVariableValue =
  | string
  | number
  | boolean
  | null
  | object
  | unknown[];

export type PromptVariables = Record<string, PromptVariableValue>;

const placeholderPattern = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const placeholderTokenPattern = /\{\{[^}]*\}\}/g;
const validPlaceholderTokenPattern = /^\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}$/;

export function renderPrompt(
  template: string,
  variables: PromptVariables,
): PromptResult<string> {
  const unresolved = findMalformedTemplatePlaceholders(template);
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: `Unresolved prompt placeholders: ${unresolved.join(", ")}`,
    };
  }

  const missing = new Set<string>();
  const rendered = template.replace(placeholderPattern, (_match, variableName: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, variableName)) {
      missing.add(variableName);
      return "";
    }

    return formatPromptValue(variables[variableName]);
  });

  if (missing.size > 0) {
    return {
      ok: false,
      error: `Missing prompt variables: ${Array.from(missing).sort().join(", ")}`,
    };
  }

  return { ok: true, value: rendered };
}

export function findPromptVariables(template: string): string[] {
  return Array.from(
    new Set(Array.from(template.matchAll(placeholderPattern), (match) => match[1])),
  ).sort();
}

function formatPromptValue(value: PromptVariableValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value, null, 2);
}

function findMalformedTemplatePlaceholders(template: string): string[] {
  return Array.from(new Set(template.match(placeholderTokenPattern) ?? []))
    .filter((placeholder) => !validPlaceholderTokenPattern.test(placeholder))
    .sort();
}
