import { describe, expect, it } from "vitest";
import type { QuizConfig } from "@lcqb/contracts";
import { DEFAULT_LEADCATCH_QUIZ, validateQuizDag } from "../src/bots/leadcatch/index.js";

describe("Stage 4: LeadCatch DAG Quiz Validator", () => {
  it("1. should validate that the default LeadCatch quiz is a valid 3-step DAG", () => {
    const result = validateQuizDag(DEFAULT_LEADCATCH_QUIZ);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("2. should accept valid 4-step and 5-step branching DAG configurations", () => {
    const valid4Step: QuizConfig = {
      startNodeId: "step1",
      nodes: [
        {
          id: "step1",
          title: { ru: "Шаг 1", uz: "1-qadam" },
          options: [
            { id: "o1", text: { ru: "А", uz: "A" }, nextNodeId: "step2_a" },
            { id: "o2", text: { ru: "Б", uz: "B" }, nextNodeId: "step2_b" },
          ],
        },
        {
          id: "step2_a",
          title: { ru: "Шаг 2А", uz: "2A-qadam" },
          options: [{ id: "o2a", text: { ru: "Ок", uz: "Ok" }, nextNodeId: "step3" }],
        },
        {
          id: "step2_b",
          title: { ru: "Шаг 2Б", uz: "2B-qadam" },
          options: [{ id: "o2b", text: { ru: "Ок", uz: "Ok" }, nextNodeId: "step3" }],
        },
        {
          id: "step3",
          title: { ru: "Шаг 3", uz: "3-qadam" },
          options: [{ id: "o3", text: { ru: "Дальше", uz: "Oldinga" }, nextNodeId: "step4" }],
        },
        {
          id: "step4",
          title: { ru: "Шаг 4", uz: "4-qadam" },
          options: [{ id: "o4", text: { ru: "Финал", uz: "Tugatish" }, nextNodeId: null }],
        },
      ],
    };

    const res4 = validateQuizDag(valid4Step);
    expect(res4.valid).toBe(true);
    expect(res4.errors).toEqual([]);

    // 5-step
    const valid5Step: QuizConfig = {
      startNodeId: "n1",
      nodes: [
        {
          id: "n1",
          title: { ru: "1", uz: "1" },
          options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "n2" }],
        },
        {
          id: "n2",
          title: { ru: "2", uz: "2" },
          options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "n3" }],
        },
        {
          id: "n3",
          title: { ru: "3", uz: "3" },
          options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: "n4" }],
        },
        {
          id: "n4",
          title: { ru: "4", uz: "4" },
          options: [{ id: "o4", text: { ru: "4", uz: "4" }, nextNodeId: "n5" }],
        },
        {
          id: "n5",
          title: { ru: "5", uz: "5" },
          options: [{ id: "o5", text: { ru: "5", uz: "5" }, nextNodeId: null }],
        },
      ],
    };

    const res5 = validateQuizDag(valid5Step);
    expect(res5.valid).toBe(true);
    expect(res5.errors).toEqual([]);
  });

  it("3. should reject graphs with cycles (q1 -> q2 -> q3 -> q1)", () => {
    const cyclicQuiz: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "1", uz: "1" },
          options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }],
        },
        {
          id: "q2",
          title: { ru: "2", uz: "2" },
          options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }],
        },
        {
          id: "q3",
          title: { ru: "3", uz: "3" },
          options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: "q1" }],
        },
      ],
    };

    const result = validateQuizDag(cyclicQuiz);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Cycle detected"))).toBe(true);
  });

  it("4. should reject graphs with self-loops (node -> node)", () => {
    const selfLoopQuiz: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "1", uz: "1" },
          options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q1" }],
        },
        {
          id: "q2",
          title: { ru: "2", uz: "2" },
          options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }],
        },
        {
          id: "q3",
          title: { ru: "3", uz: "3" },
          options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }],
        },
      ],
    };

    const result = validateQuizDag(selfLoopQuiz);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Cycle detected"))).toBe(true);
  });

  it("5. should reject unreachable island nodes", () => {
    const islandQuiz: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "1", uz: "1" },
          options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }],
        },
        {
          id: "q2",
          title: { ru: "2", uz: "2" },
          options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }],
        },
        {
          id: "q3",
          title: { ru: "3", uz: "3" },
          options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }],
        },
        {
          id: "island_node",
          title: { ru: "Остров", uz: "Orol" },
          options: [{ id: "oi", text: { ru: "X", uz: "X" }, nextNodeId: null }],
        },
      ],
    };

    const result = validateQuizDag(islandQuiz);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Unreachable nodes") && e.includes("island_node"))).toBe(true);
  });

  it("6. should reject quiz if any path has fewer than 3 steps (e.g. 2 steps)", () => {
    const tooShortQuiz: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "1", uz: "1" },
          options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }],
        },
        {
          id: "q2",
          title: { ru: "2", uz: "2" },
          options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: null }],
        },
      ],
    };

    const result = validateQuizDag(tooShortQuiz);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("7. should reject quiz if any path has more than 5 steps (e.g. 6 steps)", () => {
    const tooLongQuiz: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        { id: "q1", title: { ru: "1", uz: "1" }, options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }] },
        { id: "q2", title: { ru: "2", uz: "2" }, options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q3", title: { ru: "3", uz: "3" }, options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: "q4" }] },
        { id: "q4", title: { ru: "4", uz: "4" }, options: [{ id: "o4", text: { ru: "4", uz: "4" }, nextNodeId: "q5" }] },
        { id: "q5", title: { ru: "5", uz: "5" }, options: [{ id: "o5", text: { ru: "5", uz: "5" }, nextNodeId: "q6" }] },
        { id: "q6", title: { ru: "6", uz: "6" }, options: [{ id: "o6", text: { ru: "6", uz: "6" }, nextNodeId: null }] },
      ],
    };

    const result = validateQuizDag(tooLongQuiz);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too long"))).toBe(true);
  });

  it("8. should reject non-existent startNodeId", () => {
    const invalidStart: QuizConfig = {
      startNodeId: "unknown_start",
      nodes: [
        { id: "q1", title: { ru: "1", uz: "1" }, options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }] },
        { id: "q2", title: { ru: "2", uz: "2" }, options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q3", title: { ru: "3", uz: "3" }, options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }] },
      ],
    };

    const result = validateQuizDag(invalidStart);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown_start"))).toBe(true);
  });

  it("9. should reject duplicate node IDs", () => {
    const duplicateNodes: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        { id: "q1", title: { ru: "1", uz: "1" }, options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "q2" }] },
        { id: "q2", title: { ru: "2", uz: "2" }, options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q2", title: { ru: "2 дубль", uz: "2 dubl" }, options: [{ id: "o2b", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q3", title: { ru: "3", uz: "3" }, options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }] },
      ],
    };

    const result = validateQuizDag(duplicateNodes);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate node IDs"))).toBe(true);
  });

  it("10. should reject duplicate option IDs within a single node", () => {
    const dupOption: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        {
          id: "q1",
          title: { ru: "1", uz: "1" },
          options: [
            { id: "dup", text: { ru: "A", uz: "A" }, nextNodeId: "q2" },
            { id: "dup", text: { ru: "B", uz: "B" }, nextNodeId: "q2" },
          ],
        },
        { id: "q2", title: { ru: "2", uz: "2" }, options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q3", title: { ru: "3", uz: "3" }, options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }] },
      ],
    };

    const result = validateQuizDag(dupOption);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate option ID 'dup'"))).toBe(true);
  });

  it("11. should reject nextNodeId pointing to a non-existent node", () => {
    const brokenRef: QuizConfig = {
      startNodeId: "q1",
      nodes: [
        { id: "q1", title: { ru: "1", uz: "1" }, options: [{ id: "o1", text: { ru: "1", uz: "1" }, nextNodeId: "ghost_node" }] },
        { id: "q2", title: { ru: "2", uz: "2" }, options: [{ id: "o2", text: { ru: "2", uz: "2" }, nextNodeId: "q3" }] },
        { id: "q3", title: { ru: "3", uz: "3" }, options: [{ id: "o3", text: { ru: "3", uz: "3" }, nextNodeId: null }] },
      ],
    };

    const result = validateQuizDag(brokenRef);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ghost_node"))).toBe(true);
  });
});
