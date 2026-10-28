/** Build Claude's upload format without touching the DOM or a server. */
export async function buildSkillArchive(
  skills: readonly { name: string; content: string }[],
) {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  for (const skill of skills)
    archive.file(`${skill.name}/SKILL.md`, skill.content);
  return archive.generateAsync({ type: "uint8array" });
}
