import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  permission: vi.fn(),
  db: vi.fn(),
  fetchAll: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/permissions/check", () => ({
  loadCurrentUser: mocks.user,
  hasPermission: mocks.permission,
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: mocks.db,
  fetchAll: mocks.fetchAll,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("./prompt-studio-client", () => ({ default: () => null }));
import Page from "./page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ isAdmin: true });
  mocks.permission.mockReturnValue(true);
  mocks.redirect.mockImplementation(() => {
    throw new Error("redirect");
  });
});
it("keeps the builder available and marks persistence unavailable before migration", async () => {
  const from = vi.fn(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () =>
        Promise.resolve({
          data: null,
          error: { code: "PGRST205", message: "Missing table in schema cache" },
        }),
    };
    return query;
  });
  mocks.db.mockReturnValue({ from });
  mocks.fetchAll.mockResolvedValue({
    data: [{ id: "client", name: "Example", phone: null, address: null }],
  });
  const page = await Page();
  expect(page.props.installed).toBe(false);
  expect(page.props.clients).toHaveLength(1);
  expect(page.props.initialTemplates).toEqual([]);
  expect(page.props.initialLibrary).toEqual([]);
  expect(mocks.fetchAll).toHaveBeenCalledTimes(1);
});
it("gates the page before privileged reads", async () => {
  mocks.permission.mockReturnValue(false);
  await expect(Page()).rejects.toThrow("redirect");
  expect(mocks.db).not.toHaveBeenCalled();
});
it("does not disguise an operational error as an unapplied migration", async () => {
  mocks.db.mockReturnValue({
    from: () => ({
      select: () => ({
        limit: () =>
          Promise.resolve({
            error: { code: "42501", message: "Permission denied" },
          }),
      }),
    }),
  });
  await expect(Page()).rejects.toThrow("Could not load Prompt Studio");
});
