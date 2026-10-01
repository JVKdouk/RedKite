import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Task } from "../log.js";
import type { Deployment } from "../types.js";
import { elapsed } from "./screen.js";
import { causes } from "./log.js";
import type { Viewer } from "./viewer.js";

// The only complete record of a failed run, written down while it happened

// Named rather than read from TMPDIR, which a runner could point elsewhere
const ROOT = "/tmp";

type Kind = "info" | "warn" | "fail" | "done" | "plan" | "step" | "command";

type Entry = { at: number; kind: Kind; text: string };

type Said = { at: number; kind: "detail" | "line"; text: string };

type StepRecord = {
  label: string;
  // How many steps it ran inside, so the index reads as the view did
  depth: number;
  started: number;
  ended?: number;
  state: "running" | "done" | "failed";
  note?: string;
  said: Said[];
};

export type Transcript = {
  started: number;
  entries: Entry[];
  steps: StepRecord[];
};

export type Crash = {
  project: string;
  environment: string;
  command: string;
  version: string;
  argv: string[];
  outcome: string;
  at: number;
  error?: unknown;
};

// A copy kept beside the wrapped log, never a replacement for it
export function recording(log: Viewer, now: () => number = Date.now) {
  const transcript: Transcript = { started: now(), entries: [], steps: [] };
  const note = (kind: Kind, text: string) => transcript.entries.push({ at: now(), kind, text });

  const open = (label: string, task: Task, depth: number): Task => {
    const record: StepRecord = { label, depth, started: now(), state: "running", said: [] };

    transcript.steps.push(record);
    note("step", `${label} started`);

    const settle = (state: "done" | "failed", message?: string) => {
      record.state = state;
      record.ended = now();
      record.note = message;

      const said = message ? `: ${message}` : "";
      note("step", `${label} ${state}${said} (${elapsed(record.ended, record.started)})`);
    };

    return {
      detail: (message) => {
        record.said.push({ at: now(), kind: "detail", text: message });
        task.detail(message);
      },
      line: (message) => {
        record.said.push({ at: now(), kind: "line", text: message });
        task.line(message);
      },
      done: (message) => {
        settle("done", message);
        task.done(message);
      },
      fail: (message) => {
        settle("failed", message);
        task.fail(message);
      },
      step: (child) => open(child, task.step(child), depth + 1),
    };
  };

  const step = (label: string) => open(label, log.step(label), 0);

  const recorded: Viewer = Object.assign(
    (message: string) => {
      note("info", message);
      log(message);
    },
    {
      plan: (points: string[]) => {
        note("plan", points.join(", "));
        log.plan?.(points);
      },
      warn: (message: string) => {
        note("warn", message);
        log.warn(message);
      },
      fail: (message: string) => {
        note("fail", message);
        log.fail(message);
      },
      done: (message: string) => {
        note("done", message);
        log.done(message);
      },
      step,
      close: () => log.close(),
    },
  );

  // Kept whether it was shown or not, being what a crash log is read for
  const command = (text: string) => note("command", text);

  return { log: recorded, transcript, command };
}

// One per failed run, with both path segments made safe first
export function crashDirectory(project: string, environment: string, at: Date, root = ROOT) {
  const moment = at.toISOString().replaceAll(":", "-");
  return join(root, slug(project), slug(environment), `crash-${moment}`);
}

// One file per step, numbered in start order, so two labels cannot share one
export function crashFiles(transcript: Transcript, crash: Crash): Record<string, string> {
  const width = Math.max(2, String(transcript.steps.length).length);

  const named = transcript.steps.map((step, index) => ({
    step,
    file: `${pad(index + 1, width)}-${slug(step.label)}.log`,
  }));

  return {
    "run.log": runLog(transcript, crash, named),
    ...Object.fromEntries(
      named.map(({ step, file }) => [file, stepLog(transcript, crash, step)]),
    ),
  };
}

// Private to whoever ran it: /tmp is shared, and output can say too much
export async function dumpCrash(
  config: Deployment,
  transcript: Transcript,
  crash: Crash,
  root = ROOT,
) {
  if (config.options?.crashLog === false) return undefined;

  const directory = crashDirectory(config.project, crash.environment, new Date(crash.at), root);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });

  // Not recursive: a directory already there belongs to another run
  await mkdir(directory, { mode: 0o700 });

  for (const [name, contents] of Object.entries(crashFiles(transcript, crash))) {
    await writeFile(join(directory, name), contents, { mode: 0o600, flag: "wx" });
  }

  return directory;
}

const MARK: Record<Kind, string> = {
  info: "",
  warn: "warn  ",
  fail: "fail  ",
  done: "done  ",
  plan: "plan  ",
  step: "step  ",
  command: "",
};

type Named = { step: StepRecord; file: string };

function runLog(transcript: Transcript, crash: Crash, named: Named[]) {
  const since = sinceStart(transcript);

  const index = named.map(({ step, file }) => {
    const took = elapsed(step.ended ?? crash.at, step.started);
    return `${`${"  ".repeat(step.depth)}${file}`.padEnd(40)} ${step.state.padEnd(8)} ${took}`;
  });

  return lines([
    "redkite crash log",
    "",
    `project      ${crash.project}`,
    `environment  ${crash.environment}`,
    `command      ${crash.command}`,
    `outcome      ${crash.outcome}`,
    `version      ${crash.version}`,
    `argv         ${crash.argv.join(" ")}`,
    `started      ${new Date(transcript.started).toISOString()}`,
    `ended        ${new Date(crash.at).toISOString()}`,
    "",
    "== error",
    ...errorLines(crash.error),
    "",
    "== steps, each in its own file beside this one",
    ...(index.length > 0 ? index : ["none started"]),
    "",
    "== log",
    ...transcript.entries.map(
      (entry) => `${since(entry.at)}  ${MARK[entry.kind]}${indent(entry.text)}`,
    ),
  ]);
}

// Stamped from the start of the run, so a line can be found among the rest
function stepLog(transcript: Transcript, crash: Crash, step: StepRecord) {
  const since = sinceStart(transcript);
  const note = step.note ? `: ${step.note}` : "";

  return lines([
    `step         ${step.label}`,
    `state        ${step.state}${indent(note)}`,
    `started      ${new Date(step.started).toISOString()}`,
    `ended        ${step.ended ? new Date(step.ended).toISOString() : "still running when the run ended"}`,
    `took         ${elapsed(step.ended ?? crash.at, step.started)}`,
    "",
    ...step.said.map(
      (said) => `${since(said.at)}  ${said.kind === "detail" ? "· " : "| "}${indent(said.text)}`,
    ),
  ]);
}

// Whole, with every error in the chain: the step that threw is often two down
function errorLines(error: unknown) {
  if (error === undefined) return ["none thrown"];
  if (!(error instanceof Error)) return [String(error)];

  return causes(error).flatMap((link, index) => [
    ...(index > 0 ? ["", "caused by"] : []),
    link.stack ?? link.message,
  ]);
}

function sinceStart(transcript: Transcript) {
  return (at: number) => `+${clock(at - transcript.started)}`;
}

function lines(rows: string[]) {
  return `${rows.join("\n")}\n`;
}

// Continuation lines line up under the text, not the timestamp
function indent(text: string) {
  return text.replaceAll("\n", "\n              ");
}

function slug(text: string) {
  const slugged = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slugged || "unnamed";
}

function clock(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor(ms / 1000) % 60;
  const millis = ms % 1000;

  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

function pad(value: number, width: number) {
  return String(value).padStart(width, "0");
}
