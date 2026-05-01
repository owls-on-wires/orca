/**
 * Task resolution — DAG construction, dependency checking, filtering.
 */

import type { ResolvedTask } from "./schema";

/** Build a dependency graph and return tasks in topological order. */
export function resolveExecutionOrder(tasks: ResolvedTask[]): ResolvedTask[] {
  if (tasks.length === 0) return [];

  const byId = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const result: ResolvedTask[] = [];

  function visit(id: string, stack: Set<string>) {
    if (visited.has(id)) return;
    if (stack.has(id)) return; // cycle — handled by validateDependencies
    stack.add(id);
    const task = byId.get(id);
    if (!task) return;
    for (const dep of task.depends_on) {
      visit(dep, stack);
    }
    stack.delete(id);
    visited.add(id);
    result.push(task);
  }

  // Visit in original order to preserve ordering for independent tasks
  for (const task of tasks) {
    visit(task.id, new Set());
  }

  return result;
}

/** Filter tasks by tags. */
export function filterTasks(
  tasks: ResolvedTask[],
  include?: string[],
  exclude?: string[],
): ResolvedTask[] {
  let filtered = tasks;

  if (include && include.length > 0) {
    const includeSet = new Set(include);
    filtered = filtered.filter(t => t.tags.some(tag => includeSet.has(tag)));
  }

  if (exclude && exclude.length > 0) {
    const excludeSet = new Set(exclude);
    filtered = filtered.filter(t => !t.tags.some(tag => excludeSet.has(tag)));
  }

  return filtered;
}

/** Validate dependency references (no missing IDs, no cycles, no duplicates). */
export function validateDependencies(tasks: ResolvedTask[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  // Check for duplicates
  for (const task of tasks) {
    if (ids.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    ids.add(task.id);
  }

  // Check for missing dependencies
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        errors.push(`Task '${task.id}' depends on '${dep}' which does not exist`);
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    inStack.add(id);
    const task = tasks.find(t => t.id === id);
    if (task) {
      for (const dep of task.depends_on) {
        if (ids.has(dep) && hasCycle(dep)) return true;
      }
    }
    inStack.delete(id);
    visited.add(id);
    return false;
  }

  for (const task of tasks) {
    visited.clear();
    inStack.clear();
    if (hasCycle(task.id)) {
      errors.push(`Dependency cycle detected involving '${task.id}'`);
      break;
    }
  }

  return errors;
}
