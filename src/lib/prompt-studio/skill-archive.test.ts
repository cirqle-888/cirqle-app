import { expect, it } from "vitest";
import JSZip from "jszip";
import { buildSkillArchive } from "./skill-archive";
import { PROMPT_SKILLS } from "./skills";

it("packages one skill in the Claude upload folder with exact source text", async () => {
  const skill = PROMPT_SKILLS[0];
  const zip = await JSZip.loadAsync(await buildSkillArchive([skill]));
  const files = Object.values(zip.files).filter((f) => !f.dir);
  expect(files.map((f) => f.name)).toEqual([`${skill.name}/SKILL.md`]);
  expect(await files[0].async("string")).toBe(skill.content);
});
it("packages all skills in separate folders", async () => {
  const zip = await JSZip.loadAsync(await buildSkillArchive(PROMPT_SKILLS));
  expect(Object.values(zip.files).filter((f) => !f.dir)).toHaveLength(4);
  for (const skill of PROMPT_SKILLS)
    expect(await zip.file(`${skill.name}/SKILL.md`)!.async("string")).toBe(
      skill.content,
    );
});
