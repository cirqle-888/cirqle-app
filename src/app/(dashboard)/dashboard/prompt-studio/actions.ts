"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requirePermission,
  requireReadPermission,
} from "@/lib/permissions/check";
import { callGroqText } from "@/lib/ai/groq";
import { CLIENT_CARD_FIELDS } from "@/lib/prompt-studio/client-card";
import { placeholdersIn } from "@/lib/prompt-studio/render";
import {
  CATEGORY_IDS,
  FIELD_TYPES,
  LIBRARY_PAGE,
  PREVIEW_KINDS,
  type ActionResult,
  type ClientCard,
  type CustomTemplate,
  type LibraryInput,
  type LibraryItem,
  type LibraryQuery,
  type PromptField,
  type SavedCard,
} from "@/lib/prompt-studio/types";

import { TEMPLATES } from "@/lib/prompt-studio/templates";
import { quickLookValues, type SavedQuickLook } from "@/lib/prompt-studio/quick-looks";

const path = "/dashboard/prompt-studio";
const CONFLICT =
  "Someone else changed this Client Card a moment ago. Reload the page to see their version, then make your change again.";

function fail(error: unknown) {
  return {
    ok: false,
    error:
      error instanceof Error
        ? error.message
        : "Could not save. Please try again.",
  };
}
function check(error: { message: string } | null) {
  if (error)
    throw new Error(
      /does not exist|schema cache/i.test(error.message)
        ? "Prompt Studio is not set up yet. Ask an admin to apply the migration."
        : error.message,
    );
}
function strings(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (v) => typeof v === "string" && v.length <= 50000,
    )
  );
}
/** A string no longer than `max` (or, when `optional`, also null/undefined). */
function text(value: unknown, max: number, optional = false): boolean {
  if (value == null) return optional;
  return typeof value === "string" && value.length <= max;
}

export async function saveClientCard(
  clientId: string,
  card: ClientCard,
  /** updated_at of the card as it was loaded; null for a new card. */
  expectedUpdatedAt?: string | null,
): Promise<ActionResult<SavedCard>> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (!text(clientId, 64) || !clientId)
      throw new Error("Please choose a client.");
    if (!strings(card) || !card.brand?.trim())
      throw new Error("Please enter a brand.");
    const clean = Object.fromEntries(
      CLIENT_CARD_FIELDS.map((f) => [f.key, card[f.key] || ""]),
    );
    const row = {
      card: clean,
      updated_by: auth.employeeId,
      updated_at: new Date().toISOString(),
    };
    const db = createAdminClient();
    // Two people editing the same card: the second save must not silently wipe
    // the first, so a save only lands on the version it was made from.
    if (expectedUpdatedAt) {
      const { data, error } = await db
        .from("prompt_client_cards")
        .update(row)
        .eq("client_id", clientId)
        .eq("updated_at", expectedUpdatedAt)
        .select("client_id, card, updated_at")
        .maybeSingle();
      check(error);
      if (!data) throw new Error(CONFLICT);
      revalidatePath(path);
      return { ok: true, data: data as SavedCard };
    }
    const { data, error } = await db
      .from("prompt_client_cards")
      .insert({ ...row, client_id: clientId })
      .select("client_id, card, updated_at")
      .single();
    if (error && (error as { code?: string }).code === "23505")
      throw new Error(CONFLICT);
    check(error);
    revalidatePath(path);
    return { ok: true, data: data as SavedCard };
  } catch (e) {
    return fail(e);
  }
}

function validField(f: PromptField): boolean {
  if (!f || typeof f !== "object") return false;
  if (!text(f.key, 60) || !text(f.label, 120) || !f.label.trim()) return false;
  if (!FIELD_TYPES.includes(f.type)) return false;
  if (!text(f.placeholder, 300, true) || !text(f.help, 300, true)) return false;
  if (f.preview != null && !PREVIEW_KINDS.includes(f.preview)) return false;
  if (!text(f.showIf, 60, true)) return false;
  if (f.type === "select" || f.type === "choice" || f.type === "multi")
    // Blank lines in the "one per line" box are ignored (they are dropped on save).
    return (
      Array.isArray(f.options) &&
      f.options.length <= 50 &&
      f.options.every((o) => text(o, 200)) &&
      f.options.some((o) => !!o.trim())
    );
  return true;
}

export async function saveCustomTemplate(
  t: CustomTemplate,
): Promise<ActionResult<CustomTemplate>> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (
      !t ||
      !text(t.name, 120) ||
      !t.name.trim() ||
      !text(t.body, 50000) ||
      !t.body.trim() ||
      !text(t.purpose, 500, true) ||
      !text(t.useIn, 300, true) ||
      !CATEGORY_IDS.includes(t.category)
    )
      throw new Error("Enter a name, category and template body.");
    const keys = placeholdersIn(t.body);
    // Tick-box fields are not in the body; every other field must be.
    const inBody = Array.isArray(t.fields)
      ? t.fields.filter((f) => f?.type !== "toggle")
      : [];
    if (
      !Array.isArray(t.fields) ||
      t.fields.length > 80 ||
      new Set(t.fields.map((f) => f?.key)).size !== t.fields.length ||
      keys.length !== inBody.length ||
      keys.some((k) => !inBody.some((f) => f.key === k)) ||
      !t.fields.every(validField)
    )
      throw new Error(
        "Check the detected fields: each needs a label, and choice fields need options.",
      );
    const db = createAdminClient();
    const row = {
      name: t.name.trim(),
      category: t.category,
      purpose: t.purpose || "",
      use_in: t.useIn || "",
      uses_client_card: !!t.usesClientCard,
      fields: t.fields.map((f) => ({
        ...f,
        options: f.options?.map((o) => o.trim()).filter(Boolean),
      })),
      body: t.body,
      updated_at: new Date().toISOString(),
    };
    const id = t.id || crypto.randomUUID();
    const key = t.id
      ? t.key
      : `custom-${t.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 50)}-${id.slice(0, 8)}`;
    const result = t.id
      ? await db
          .from("prompt_templates")
          .update(row)
          .eq("id", t.id)
          .is("deleted_at", null)
          .select("id, key")
          .single()
      : await db
          .from("prompt_templates")
          .insert({
            ...row,
            id,
            key,
            based_on: t.based_on || null,
            created_by: auth.employeeId,
          })
          .select("id, key")
          .single();
    check(result.error);
    revalidatePath(path);
    return {
      ok: true,
      data: { ...t, ...row, useIn: row.use_in, id, key: result.data!.key },
    };
  } catch (e) {
    return fail(e);
  }
}
export async function deleteCustomTemplate(id: string): Promise<ActionResult> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    const { error } = await createAdminClient()
      .from("prompt_templates")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    check(error);
    revalidatePath(path);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
export async function saveToLibrary(
  row: LibraryInput,
): Promise<ActionResult<LibraryItem>> {
  const auth = await requirePermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    if (
      !row ||
      !text(row.prompt, 100000) ||
      !row.prompt.trim() ||
      !strings(row.inputs) ||
      !text(row.template_key, 200) ||
      !row.template_key ||
      !text(row.template_name, 200) ||
      !row.template_name ||
      !text(row.title, 200, true) ||
      !text(row.ai_result, 100000, true) ||
      !text(row.client_id, 64, true)
    )
      throw new Error("Please build a prompt first.");
    const { data, error } = await createAdminClient()
      .from("prompt_library")
      .insert({
        client_id: row.client_id || null,
        template_key: row.template_key,
        template_name: row.template_name,
        title: row.title?.trim() || null,
        inputs: row.inputs,
        prompt: row.prompt,
        ai_result: row.ai_result?.trim() || null,
        created_by: auth.employeeId,
      })
      .select("*")
      .single();
    check(error);
    revalidatePath(path);
    return { ok: true, data: data as LibraryItem };
  } catch (e) {
    return fail(e);
  }
}

/**
 * One page of saved prompts, newest first, filtered on the server so older
 * prompts stay findable without sending the whole library to the browser.
 */
export async function loadLibrary(
  q: LibraryQuery,
): Promise<ActionResult<LibraryItem[]>> {
  const auth = await requireReadPermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    let query = createAdminClient()
      .from("prompt_library")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(LIBRARY_PAGE);
    if (q?.clientId && text(q.clientId, 64)) query = query.eq("client_id", q.clientId);
    if (q?.templateKey && text(q.templateKey, 200))
      query = query.eq("template_key", q.templateKey);
    if (q?.favorites) query = query.eq("is_favorite", true);
    if (q?.before && text(q.before, 64)) query = query.lt("created_at", q.before);
    // Characters that would break the filter syntax are dropped, not escaped.
    const search = typeof q?.search === "string"
      ? q.search.replace(/[,()%*\\"'.:]/g, " ").trim().slice(0, 100)
      : "";
    if (search)
      query = query.or(
        `title.ilike.%${search}%,template_name.ilike.%${search}%,prompt.ilike.%${search}%`,
      );
    const { data, error } = await query;
    check(error);
    return { ok: true, data: (data || []) as LibraryItem[] };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleFavorite(
  id: string,
): Promise<ActionResult<boolean>> {
  const auth = await requirePermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("prompt_library")
      .select("is_favorite")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    check(error);
    const favorite = !data!.is_favorite;
    const updated = await db
      .from("prompt_library")
      .update({ is_favorite: favorite })
      .eq("id", id)
      .is("deleted_at", null);
    check(updated.error);
    revalidatePath(path);
    return { ok: true, data: favorite };
  } catch (e) {
    return fail(e);
  }
}

/** Anyone can delete their own saved prompts; managers can delete any. */
export async function deleteLibraryItem(id: string): Promise<ActionResult> {
  const auth = await requirePermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("prompt_library")
      .select("created_by")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    check(error);
    if (!data) return { ok: true };
    if (!auth.isAdmin && data.created_by !== auth.employeeId) {
      const manager = await requirePermission("prompt_studio.manage");
      if (!manager.ok)
        throw new Error(
          "Only the person who saved this prompt, or a Prompt Studio manager, can delete it.",
        );
    }
    const updated = await db
      .from("prompt_library")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    check(updated.error);
    revalidatePath(path);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function generateWithAI(
  prompt: string,
): Promise<ActionResult<string>> {
  const auth = await requirePermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 50000)
      throw new Error("Please provide a prompt under 50,000 characters.");
    // Plain text, not JSON: a long answer full of quotes and line breaks breaks
    // a JSON wrapper and came back as "empty".
    const answer = await callGroqText(
      "Follow the user's instructions exactly. Reply with the answer only: no greeting, no explanation, no markdown code fences.",
      prompt,
      { maxTokens: 1500, temperature: 0.4 },
    );
    const clean = answer.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    if (!clean)
      throw new Error("The AI returned an empty answer. Please try again.");
    return { ok: true, data: clean };
  } catch (e) {
    return fail(e);
  }
}


export async function saveQuickLook(input: Omit<SavedQuickLook, "id">): Promise<ActionResult<SavedQuickLook>> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (!input || !text(input.name, 120) || !input.name.trim() ||
        !text(input.template_key, 160) || !strings(input.values) ||
        JSON.stringify(input.values).length > 100000 || !text(input.language, 120) ||
        !text(input.client_id, 64, true) || !text(input.style_id, 64, true))
      throw new Error("Enter a name and valid Quick look settings.");
    const db = createAdminClient();
    let template = TEMPLATES.find(t => t.key === input.template_key);
    if (!template) {
      const result = await db.from("prompt_templates").select("*").eq("key", input.template_key).is("deleted_at", null).single();
      check(result.error);
      template = result.data;
    }
    if (!template) throw new Error("This template is no longer available.");
    const { data, error } = await db.from("prompt_quick_looks").insert({
      name: input.name.trim(), template_key: template.key,
      client_id: input.client_id || null, style_id: input.style_id || null,
      language: input.language, values: quickLookValues(template, input.values), created_by: auth.employeeId,
    }).select("id, name, template_key, client_id, values, style_id, language").single();
    check(error);
    revalidatePath(path);
    return { ok: true, data: data as SavedQuickLook };
  } catch (e) { return fail(e); }
}

export async function deleteQuickLook(id: string): Promise<ActionResult> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (!id || !text(id, 64)) throw new Error("Choose a Quick look.");
    const { error } = await createAdminClient().from("prompt_quick_looks")
      .update({ deleted_at: new Date().toISOString() }).eq("id", id);
    check(error);
    revalidatePath(path);
    return { ok: true };
  } catch (e) { return fail(e); }
}
