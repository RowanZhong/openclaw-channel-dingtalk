import { describe, it, expect } from "vitest";
import { parseQuestionTarget, questionTargetSchema } from "../../src/card/ask-user-question-target";
describe("1000 named respondents", () => {
  it("accepts 1000 distinct stable IDs in both schema and runtime", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `staff_${i}`);
    expect(
      parseQuestionTarget({ type: "group", id: "cid_group", respondentUserIds: ids })
        ?.respondentUserIds,
    ).toEqual(ids);
    expect(questionTargetSchema.properties.respondentUserIds.maxItems).toBe(1000);
  });
  it("rejects 1001 respondents and case-folded duplicates", () => {
    expect(() =>
      parseQuestionTarget({
        type: "group",
        id: "cid_group",
        respondentUserIds: Array.from({ length: 1001 }, (_, i) => `staff_${i}`),
      }),
    ).toThrow(/1000/);
    expect(() =>
      parseQuestionTarget({ type: "group", id: "cid_group", respondentUserIds: ["A", "a"] }),
    ).toThrow(/unique/);
  });
});
