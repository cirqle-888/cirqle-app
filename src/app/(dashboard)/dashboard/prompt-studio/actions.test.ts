import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomTemplate, LibraryInput } from "@/lib/prompt-studio/types";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  read: vi.fn(),
  db: vi.fn(),
  groq: vi.fn(),
}));
vi.mock("@/lib/permissions/check", () => ({
  requirePermission: mocks.guard,
  requireReadPermission: mocks.read,
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: mocks.db }));
vi.mock("@/lib/ai/groq", () => ({ callGroqText: mocks.groq }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import * as actions from "./actions";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue({ ok: false, error: "Permission denied." });
  mocks.read.mockResolvedValue({ ok: false, error: "Permission denied." });
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
it("loading the library needs view permission (a read) before touching storage", async () => {
  expect(await actions.loadLibrary({})).toEqual({ ok: false, error: "Permission denied." });
  expect(mocks.read).toHaveBeenCalledWith("prompt_studio.view");
  expect(mocks.db).not.toHaveBeenCalled();
});
it("returns a friendly error for an empty AI response", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  mocks.groq.mockResolvedValue("   ");
  expect(await actions.generateWithAI("A short clip")).toEqual({
    ok: false,
    error: "The AI returned an empty answer. Please try again.",
  });
});
it("asks for plain text (not JSON) so long answers with quotes survive", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  mocks.groq.mockResolvedValue('```\nA "quoted" prompt\nline two\n```');
  expect(await actions.generateWithAI("A short clip")).toEqual({
    ok: true,
    data: 'A "quoted" prompt\nline two',
  });
  const [system, user, opts] = mocks.groq.mock.calls[0];
  expect(system).not.toMatch(/JSON/);
  expect(user).toBe("A short clip");
  expect(opts).toEqual({ maxTokens: 1500, temperature: 0.4 });
});

/** A chainable fake of the Supabase query builder; each from() gets the next result. */
function fakeDb(results: Record<string, unknown>[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  let n = 0;
  return {
    calls,
    client: {
      from(table: string) {
        const entry = { table, ops: [] as [string, unknown[]][] };
        calls.push(entry);
        const result = results[n++] ?? { data: null, error: null };
        const q: Record<string, unknown> = {};
        for (const op of ["select", "insert", "update", "eq", "is", "lt", "or", "order", "limit"])
          q[op] = (...args: unknown[]) => {
            entry.ops.push([op, args]);
            return q;
          };
        q.single = q.maybeSingle = () => Promise.resolve(result);
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
        return q;
      },
    },
  };
}
describe("Client Card saves never overwrite a newer card", () => {
  beforeEach(() => mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" }));
  it("updates only the version it was opened from", async () => {
    const db = fakeDb([{ data: { client_id: "c", card: {}, updated_at: "t2" }, error: null }]);
    mocks.db.mockReturnValue(db.client);
    const r = await actions.saveClientCard("c", { brand: "Seastar" }, "t1");
    expect(r.ok).toBe(true);
    expect(db.calls[0].ops).toContainEqual(["eq", ["updated_at", "t1"]]);
  });
  it("says someone else changed it when that version is gone", async () => {
    mocks.db.mockReturnValue(fakeDb([{ data: null, error: null }]).client);
    const r = await actions.saveClientCard("c", { brand: "Seastar" }, "t1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Someone else changed this Client Card/);
  });
  it("a new card someone else created first is a conflict, not a crash", async () => {
    mocks.db.mockReturnValue(
      fakeDb([{ data: null, error: { code: "23505", message: "duplicate key" } }]).client,
    );
    const r = await actions.saveClientCard("c", { brand: "Seastar" }, null);
    expect(r.error).toMatch(/Someone else changed this Client Card/);
  });
});
describe("deleting a saved prompt", () => {
  it("the person who saved it can delete it", async () => {
    mocks.guard.mockResolvedValue({ ok: true, employeeId: "me", isAdmin: false });
    const db = fakeDb([{ data: { created_by: "me" }, error: null }, { data: null, error: null }]);
    mocks.db.mockReturnValue(db.client);
    expect(await actions.deleteLibraryItem("p1")).toEqual({ ok: true });
    expect(db.calls[1].ops[0][0]).toBe("update");
  });
  it("someone else's needs the manage permission", async () => {
    mocks.guard
      .mockResolvedValueOnce({ ok: true, employeeId: "me", isAdmin: false })
      .mockResolvedValueOnce({ ok: false, error: "Permission denied." });
    const db = fakeDb([{ data: { created_by: "other" }, error: null }]);
    mocks.db.mockReturnValue(db.client);
    const r = await actions.deleteLibraryItem("p1");
    expect(r.ok).toBe(false);
    expect(mocks.guard).toHaveBeenLastCalledWith("prompt_studio.manage");
    expect(db.calls).toHaveLength(1);
  });
});
it("rejects an over-long title or answer before writing", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  const row: LibraryInput = {
    client_id: null,
    template_key: "ad-video-clip",
    template_name: "Video clip",
    title: "x".repeat(201),
    inputs: {},
    prompt: "p",
    ai_result: null,
  };
  expect((await actions.saveToLibrary(row)).ok).toBe(false);
  expect((await actions.saveToLibrary({ ...row, title: null, ai_result: "x".repeat(100001) })).ok).toBe(false);
  expect(mocks.db).not.toHaveBeenCalled();
});
it("accepts a custom template with picture-card and tick-box fields", async () => {
  mocks.guard.mockResolvedValue({ ok: true, employeeId: "actor" });
  mocks.db.mockReturnValue(fakeDb([{ data: { id: "i", key: "custom-x" }, error: null }]).client);
  const r = await actions.saveCustomTemplate({
    id: "",
    key: "",
    name: "Offer text",
    category: "flyer",
    purpose: "",
    useIn: "",
    usesClientCard: true,
    body: "{{effect}} {{extras}}",
    fields: [
      { key: "effect", label: "Effect", type: "choice", preview: "text-effect", options: ["Neon glow", " "] },
      { key: "extras", label: "Extras", type: "multi", options: ["Glow"] },
    ],
  });
  expect(r.ok).toBe(true);
  expect(r.data?.fields[0].options).toEqual(["Neon glow"]);
});
