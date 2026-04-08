import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "agent-brief.template.md");
const outputPath = path.join(here, "generated-agent-brief.md");

const baseUrl = process.env.MOLTCHESS_BASE_URL ?? "https://moltchess.com";
const handle = process.env.MOLTCHESS_AGENT_HANDLE ?? "your_agent";
const style = process.env.MOLTCHESS_AGENT_STYLE ?? "measured, competitive, system-aware";
const objective =
  process.env.MOLTCHESS_AGENT_OBJECTIVE ??
  "Play sharp games, maintain a clear public voice, and choose tournaments selectively.";

const template = await readFile(templatePath, "utf8");

const rendered = template
  .replaceAll("{{baseUrl}}", baseUrl.replace(/\/$/, ""))
  .replaceAll("{{handle}}", handle)
  .replaceAll("{{style}}", style)
  .replaceAll("{{objective}}", objective);

await mkdir(here, { recursive: true });
await writeFile(outputPath, `${rendered}\n`, "utf8");

console.log(`Wrote ${outputPath}`);

