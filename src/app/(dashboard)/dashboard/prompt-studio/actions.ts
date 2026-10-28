"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/permissions/check";
import { callGroqJSON } from "@/lib/ai/groq";
import { CLIENT_CARD_FIELDS } from "@/lib/prompt-studio/client-card";
import { placeholdersIn } from "@/lib/prompt-studio/render";
import type {
  ActionResult,
  ClientCard,
  CustomTemplate,
  LibraryInput,
  LibraryItem,
  SavedCard,
} from "@/lib/prompt-studio/types";

const path = "/dashboard/prompt-studio";
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
export async function saveClientCard(
  clientId: string,
  card: ClientCard,
): Promise<ActionResult<SavedCard>> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (!strings(card) || !card.brand?.trim())
      throw new Error("Please enter a brand.");
    const clean = Object.fromEntries(
      CLIENT_CARD_FIELDS.map((f) => [f.key, card[f.key] || ""]),
    );
    const { data, error } = await createAdminClient()
      .from("prompt_client_cards")
      .upsert(
        {
          client_id: clientId,
          card: clean,
          updated_by: auth.employeeId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      )
      .select("client_id, card, updated_at")
      .single();
    check(error);
    revalidatePath(path);
    return { ok: true, data: data as SavedCard };
  } catch (e) {
    return fail(e);
  }
}
export async function saveCustomTemplate(
  t: CustomTemplate,
): Promise<ActionResult<CustomTemplate>> {
  const auth = await requirePermission("prompt_studio.manage");
  if (!auth.ok) return auth;
  try {
    if (
      !t ||
      typeof t.name !== "string" ||
      !t.name.trim() ||
      typeof t.body !== "string" ||
      !t.body.trim() ||
      t.body.length > 50000 ||
      !["ad", "film", "product", "agency", "fix"].includes(t.category)
    )
      throw new Error("Enter a name, category and template body.");
    const keys = placeholdersIn(t.body);
    if (
      !Array.isArray(t.fields) ||
      keys.length !== t.fields.length ||
      keys.some((k) => !t.fields.some((f) => f.key === k)) ||
      t.fields.some(
        (f) =>
          !["text", "textarea", "select", "number"].includes(f.type) ||
          typeof f.label !== "string" ||
          !f.label.trim() ||
          (f.type === "select" &&
            (!Array.isArray(f.options) ||
              !f.options.length ||
              f.options.some((o) => typeof o !== "string"))),
      )
    )
      throw new Error("Check the detected fields and select options.");
    const db = createAdminClient();
    const row = {
      name: t.name.trim(),
      category: t.category,
      purpose: t.purpose,
      use_in: t.useIn,
      uses_client_card: !!t.usesClientCard,
      fields: t.fields,
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
    return { ok: true, data: { ...t, id, key: result.data!.key } };
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
      typeof row.prompt !== "string" ||
      !row.prompt.trim() ||
      row.prompt.length > 100000 ||
      !strings(row.inputs) ||
      !row.template_key ||
      !row.template_name
    )
      throw new Error("Please build a prompt first.");
    const { data, error } = await createAdminClient()
      .from("prompt_library")
      .insert({
        client_id: row.client_id || null,
        template_key: row.template_key,
        template_name: row.template_name,
        title: row.title,
        inputs: row.inputs,
        prompt: row.prompt,
        ai_result: row.ai_result,
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
export async function deleteLibraryItem(id: string): Promise<ActionResult> {
  const auth = await requirePermission("prompt_studio.view");
  if (!auth.ok) return auth;
  try {
    const { error } = await createAdminClient()
      .from("prompt_library")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    check(error);
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
    const answer = await callGroqJSON(
      'Follow the user\'s instructions exactly. Reply ONLY with JSON {"result": "<your full answer as plain text>"}.',
      prompt,
      { maxTokens: 1500 },
    );
    if (typeof answer.result !== "string" || !answer.result.trim())
      throw new Error("The AI returned an empty answer. Please try again.");
    return { ok: true, data: answer.result };
  } catch (e) {
    return fail(e);
  }
}
