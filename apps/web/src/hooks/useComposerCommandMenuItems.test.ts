import { describe, expect, it } from "vitest";
import { getAvailableComposerSlashCommands } from "../composerSlashCommands";
import { normalizeSlashSkillQueryForProvider } from "./useComposerCommandMenuItems";

describe("useComposerCommandMenuItems helpers", () => {
  it("normalizes Pi /skill: slash queries for skill filtering", () => {
    expect(normalizeSlashSkillQueryForProvider("pi", "skill:review")).toBe("review");
    expect(normalizeSlashSkillQueryForProvider("pi", "skill:r")).toBe("r");
    expect(normalizeSlashSkillQueryForProvider("claudeAgent", "skill:review")).toBe("skill review");
  });

  it("does not offer plan mode commands for Pi", () => {
    const commands = getAvailableComposerSlashCommands({
      provider: "pi",
      supportsFastSlashCommand: false,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      providerNativeCommandNames: [],
    });

    expect(commands).not.toContain("plan");
    expect(commands).not.toContain("default");
    expect(commands).toContain("compact");
    expect(commands).toContain("model");
  });
});
