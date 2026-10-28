import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomTemplate, LibraryInput } from "@/lib/prompt-studio/types";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  db: vi.fn(),
  groq: vi.fn(),
}));
vi.mock("@/lib/permissions/check", () => ({ requirePermission: mocks.guard }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: mocks.db }));
vi.mock("@/lib/ai/groq", () => ({ callGroqJSON: mocks.groq }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import * as actions from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue({ ok: false, error: "Permission denied." });
});
describe("Prompt Studio action authorization", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["prompt_studio.manage", () => actions.saveClientCard("id", {})],
    [
      "prompt_studio.manage",
      () => actions.saveCustomTemplate({} as CustomTemplate),
    ],
    ["prompt_studio.manage", () => actions.deleteCustomTemplate("id")],
    ["prompt_studio.view", () => actions.saveToLibrary({} as LibraryInput)],
    ["prompt_studio.view", () => actions.toggleFavorite("id")],
    ["prompt_studio.view", () => actions.deleteLibraryItem("id")],
    ["prompt_studio.view", () => actions.generateWithAI("prompt")],
  ];
  it.each(calls)(
    "requires %s before accessing storage or AI (%#)",
    async (permission, call) => {
      expect(await call()).toEqual({ ok: false, error: "Permission denied." });
      expect(mocks.guard).toHaveBeenCalledWith(permission);
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.groq).not.toHaveBeenCalled();
    },
  );
});
it("rejects a custom template with undeclared placeholders before writing", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  const result = await actions.saveCustomTemplate({
    id: "",
    key: "",
    name: "Test",
    category: "ad",
    purpose: "",
    useIn: "",
    usesClientCard: false,
    body: "{{need}}",
    fields: [],
  });
  expect(result.ok).toBe(false);
  expect(mocks.db).not.toHaveBeenCalled();
});
it("returns a friendly error for an empty AI response", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  mocks.groq.mockResolvedValue({});
  expect(await actions.generateWithAI("A short clip")).toEqual({
    ok: false,
    error: "The AI returned an empty answer. Please try again.",
  });
});
it("uses the specified AI instruction and token limit", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  mocks.groq.mockResolvedValue({ result: "A ready prompt" });
  expect(await actions.generateWithAI("A short clip")).toEqual({
    ok: true,
    data: "A ready prompt",
  });
  expect(mocks.groq).toHaveBeenCalledWith(
    'Follow the user\'s instructions exactly. Reply ONLY with JSON {"result": "<your full answer as plain text>"}.',
    "A short clip",
    { maxTokens: 1500 },
  );
});
