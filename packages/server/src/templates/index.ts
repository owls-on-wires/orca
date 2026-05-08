/**
 * Template variable resolution.
 *
 * Two-pass replacement:
 * 1. {orca.*} variables via regex
 * 2. User variables via simple string replacement
 *
 * Variable formatting:
 * - Strings → as-is
 * - String arrays → bullet list
 * - Objects with name/description → numbered list
 * - Other → JSON serialized
 */

export interface TemplateVars {
  [key: string]: string;
}

/** Format a variable value for prompt injection. */
export function formatVariable(key: string, value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return "";

    // Array of objects with name/description → numbered list
    if (typeof value[0] === "object" && value[0] !== null && "name" in value[0]) {
      return value
        .map((item, i) => {
          const obj = item as { name: string; description?: string };
          return `${i + 1}. **${obj.name}**: ${(obj.description ?? "").trim()}`;
        })
        .join("\n");
    }

    // Array of strings → bullet list
    return value.map((item) => `- ${item}`).join("\n");
  }

  return JSON.stringify(value, null, 2);
}

/** Build template vars from a task's variables bag. */
export function buildTaskVars(
  taskId: string,
  taskTitle: string,
  variables: Record<string, unknown>,
  extras: Record<string, string>,
): TemplateVars {
  const vars: TemplateVars = {
    task_id: taskId,
    task_title: taskTitle,
    ...extras,
  };

  // Format each variable
  for (const [key, value] of Object.entries(variables)) {
    // Special handling for "tests" → "test_list"
    if (key === "tests" && Array.isArray(value)) {
      vars.test_list = formatVariable(key, value);
    }
    vars[key] = formatVariable(key, value);
  }

  return vars;
}

/** Apply template variables to a string. Two-pass: {orca.*} then {user}. */
export function applyVars(template: string, vars: TemplateVars): string {
  // Pass 1: replace {orca.xxx}
  let result = template.replace(/\{(orca\.[^}]+)\}/g, (match, key) => {
    return vars[key] ?? match;
  });

  // Pass 2: replace {user_var}
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith("orca.")) {
      result = result.replaceAll(`{${key}}`, value);
    }
  }

  return result;
}
