/**
 * The skill: `SKILL.md` for the four hosts that load skills from a directory.
 *
 * The block in an instruction file is always in context and therefore has to stay short; a skill is
 * loaded when its description matches what the agent is doing, so it can afford the command table and
 * the envelope contract. Both render the SAME discipline paragraphs from `@memhtml/contracts/guidance`,
 * so the two surfaces cannot disagree about the rules.
 *
 * The frontmatter carries exactly the two keys every host requires (`name`, `description`), and `name`
 * matches the directory, which Codex, Cursor, and OpenCode all enforce.
 */

import { RECALL_DISCIPLINE } from "@memhtml/contracts/guidance"

import { shellJoin } from "../command-line.js"
import type { CommandLine } from "../types.js"

/** The skill's directory name, which must equal the frontmatter `name`. */
export const SKILL_DIR_NAME = "memhtml"

export interface SkillOptions {
  /** The store, absolute. */
  readonly memhtmlRoot: string
  /** How this host invokes the CLI; every row of the command table is rendered from it. */
  readonly cli: CommandLine
}

/** One row of the command table: what you want, the CLI form, and the MCP tool that does the same thing. */
const COMMAND_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["Search", 'search "prose query" --dense', "memory_search"],
  ["Recall a context pack", 'recall "the question" --budget 6000', "memory_recall"],
  ["Read one memory", "read <path>", "memory_read"],
  ["Reinforce after use", "reinforce <path> --signal positive", "memory_reinforce"],
  [
    "Write a durable fact",
    'write --type semantic --title "…" --claim "…" --body "…"',
    "memory_write"
  ],
  ["Replace a stored fact", 'correct <path> --title "…" --claim "…" --body "…"', "memory_correct"]
]

export const renderSkill = (opts: SkillOptions): string => {
  const cli = shellJoin(opts.cli)
  return [
    "---",
    `name: ${SKILL_DIR_NAME}`,
    "description: Recall from and write to the memhtml long-term memory store; use before answering about past decisions, incidents, people, or preferences, and after learning a durable fact.",
    "---",
    "",
    "# memhtml memory",
    "",
    "## When to use",
    "",
    `Use this before you answer anything that could touch a past decision, an incident, a person, a stated preference, or a system you have already looked up, and again after you learn a fact worth having next session. The store is a git repository of one-fact HTML files at \`${opts.memhtmlRoot}\`, reachable through the MCP tools and through \`${cli}\`.`,
    "",
    "## How",
    "",
    ...RECALL_DISCIPLINE.flatMap((paragraph) => [paragraph, ""]),
    "## Commands",
    "",
    "| Task | CLI | MCP tool |",
    "| --- | --- | --- |",
    ...COMMAND_ROWS.map(([task, form, tool]) => `| ${task} | \`${cli} ${form}\` | \`${tool}\` |`),
    "",
    "## Contract",
    "",
    `Every command writes exactly ONE JSON envelope to stdout and logs to stderr; branch on \`code\`, never on the \`error\` prose, and read the exit status as 0 success, 2 usage, 1 runtime. \`${cli} manifest\` describes every command, flag, response type, and error code, so nothing above needs to be memorized.`,
    ""
  ].join("\n")
}
