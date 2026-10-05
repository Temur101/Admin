import type { QuizConfig, QuizNode } from "@lcqb/contracts";

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that a Quiz configuration forms a valid Directed Acyclic Graph (DAG):
 * 1. startNodeId exists.
 * 2. Node IDs are unique.
 * 3. Option IDs within each node are unique.
 * 4. All nextNodeId references point to existing nodes.
 * 5. No cycles (strictly acyclic).
 * 6. All declared nodes are reachable from startNodeId.
 * 7. Path length constraint: Every path from startNodeId to a terminal node
 *    must have between 3 and 5 question steps (inclusive).
 */
export function validateQuizDag(config: QuizConfig): DagValidationResult {
  const errors: string[] = [];

  if (!config || !Array.isArray(config.nodes) || config.nodes.length === 0) {
    return { valid: false, errors: ["Quiz config must contain at least one node"] };
  }

  const nodeMap = new Map<string, QuizNode>();
  const duplicateNodeIds = new Set<string>();

  for (const node of config.nodes) {
    if (nodeMap.has(node.id)) {
      duplicateNodeIds.add(node.id);
    } else {
      nodeMap.set(node.id, node);
    }
  }

  if (duplicateNodeIds.size > 0) {
    errors.push(`Duplicate node IDs found: ${Array.from(duplicateNodeIds).join(", ")}`);
  }

  if (!nodeMap.has(config.startNodeId)) {
    errors.push(`Start node '${config.startNodeId}' is not found in declared nodes`);
  }

  // Check option uniqueness and nextNodeId references
  for (const node of config.nodes) {
    const seenOptionIds = new Set<string>();
    for (const option of node.options) {
      if (seenOptionIds.has(option.id)) {
        errors.push(`Node '${node.id}' has duplicate option ID '${option.id}'`);
      }
      seenOptionIds.add(option.id);

      if (option.nextNodeId) {
        if (!nodeMap.has(option.nextNodeId)) {
          errors.push(
            `Node '${node.id}' option '${option.id}' references non-existent node '${option.nextNodeId}'`,
          );
        }
      }
    }
  }

  // If basic structural errors exist, stop before graph traversal
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 1. Cycle detection using DFS
  // 0: unvisited, 1: visiting (in current recursion stack), 2: visited
  const visitState = new Map<string, number>();
  for (const nodeId of nodeMap.keys()) {
    visitState.set(nodeId, 0);
  }

  let hasCycle = false;
  const cyclePath: string[] = [];

  function dfsCycle(nodeId: string, stack: string[]): boolean {
    visitState.set(nodeId, 1);
    stack.push(nodeId);

    const node = nodeMap.get(nodeId);
    if (node) {
      for (const option of node.options) {
        if (!option.nextNodeId) continue;
        const state = visitState.get(option.nextNodeId) ?? 0;
        if (state === 1) {
          hasCycle = true;
          cyclePath.push(...stack, option.nextNodeId);
          return true;
        }
        if (state === 0) {
          if (dfsCycle(option.nextNodeId, stack)) {
            return true;
          }
        }
      }
    }

    stack.pop();
    visitState.set(nodeId, 2);
    return false;
  }

  for (const nodeId of nodeMap.keys()) {
    if (visitState.get(nodeId) === 0) {
      if (dfsCycle(nodeId, [])) break;
    }
  }

  if (hasCycle) {
    errors.push(`Cycle detected in quiz graph: ${cyclePath.join(" -> ")}`);
    return { valid: false, errors };
  }

  // 2. Reachability from startNodeId
  const reachable = new Set<string>();
  function markReachable(nodeId: string): void {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;
    for (const option of node.options) {
      if (option.nextNodeId) {
        markReachable(option.nextNodeId);
      }
    }
  }

  markReachable(config.startNodeId);

  const unreachable = config.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  if (unreachable.length > 0) {
    errors.push(`Unreachable nodes from start node '${config.startNodeId}': ${unreachable.join(", ")}`);
  }

  // 3. Path length validation (min 3, max 5 steps along all paths)
  const pathLengths: number[] = [];

  function dfsPathLengths(nodeId: string, currentDepth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    let isTerminal = true;
    for (const option of node.options) {
      if (option.nextNodeId) {
        isTerminal = false;
        dfsPathLengths(option.nextNodeId, currentDepth + 1);
      }
    }

    if (isTerminal) {
      pathLengths.push(currentDepth);
    }
  }

  dfsPathLengths(config.startNodeId, 1);

  const minSteps = Math.min(...pathLengths);
  const maxSteps = Math.max(...pathLengths);

  if (minSteps < 3) {
    errors.push(`Quiz path is too short: shortest path has ${minSteps} steps (minimum is 3 steps)`);
  }
  if (maxSteps > 5) {
    errors.push(`Quiz path is too long: longest path has ${maxSteps} steps (maximum is 5 steps)`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
