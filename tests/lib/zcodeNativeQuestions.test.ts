import { describe, expect, it } from "vitest";
import { questionDto } from "../../packages/lolicode-zcode-runtime/src/compat";

describe("native plan approvals", () => {
  it("shows the actual native plan while preserving the answer_0 approval contract", () => {
    const plan =
      "# Fix the image preview\n\n1. Load the project image.\n2. Verify the preview.";
    const question = questionDto("zc:session", {
      interactionId: "approval",
      payload: {
        prompt: "ExitPlanMode changes session mode after user plan approval",
        input: { plan },
        schema: { interaction: "plan_approval" },
        questions: [
          {
            question:
              "ExitPlanMode changes session mode after user plan approval",
            header: "Plan",
            options: [{ value: "approve", label: "Approve" }],
          },
        ],
      },
    });
    expect(question.title).toBe("请确认实施计划");
    expect(question.fields[0]).toMatchObject({
      key: "answer_0",
      description: plan,
      options: [{ value: "approve", label: "同意并开始实施" }],
    });
  });
  it("does not treat arbitrary question input as an approval or expose its fields", () => {
    const question = questionDto("zc:session", {
      interactionId: "question",
      payload: {
        prompt: "Choose files",
        input: { plan: "unrelated", apiKey: "owned-private-value" },
        questions: [
          {
            question: "Files",
            multiSelect: true,
            options: [{ value: "src", label: "Source" }],
          },
        ],
      },
    });
    expect(question.title).toBe("Choose files");
    expect(question.fields[0]).toMatchObject({
      type: "multiselect",
      description: "Files",
    });
    expect(JSON.stringify(question)).not.toContain("owned-private-value");
  });
});
