import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Task } from "../log.js";
import type { Deployment } from "../types.js";
import { elapsed } from "./screen.js";
import { causes } from "./log.js";
import type { Viewer } from "./viewer.js";

// What a failed run said, kept whole. The view trims a step to its last lines
// and the alternate screen takes the rest with it, so the only complete record
// of a run that went wrong is one written down while it happened.

// Named rather than read from TMPDIR: the path is the one a person is told to
// look in, and a runner that points TMPDIR somewhere else would hide it
const ROOT = "/tmp";

type Kind = "info" | "warn" | "fail" | "done" | "plan" | "step" | "command";

type Entry = { at: number; kind: Kind; text: string };

type Said = { at: number; kind: "detail" | "line"; text: string };

type StepRecord = {
  label: string;
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

// Every call reaches the wrapped log unchanged, so the view behaves as it did.
// The transcript is a copy kept beside it, never a replacement for it
export function recording(log: Viewer, now: () => number = Date.now) {
  const transcript: Transcript = { started: now(), entries: [], steps: [] };
  const note = (kind: Kind, text: string) => transcript.entries.push({ at: now(), kind, text });

  const step = (label: string): Task => {
    const record: StepRecord = { label, started: now(), state: "running", said: [] };
    const task = log.step(label);

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
    };
  };

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

  // A host command is only shown with --verbose, and is exactly what a crash log
  // is read for, so it is kept whether it was shown or not
  const command = (text: string) => note("command", text);

  return { log: recorded, transcript, command };
}

// One directory per failed run, under the environment it failed in. Named from
// the command line, so both segments are made safe to be a path first
export function crashDirectory(project: string, environment: string, at: Date, root = ROOT) {
  const moment = at.toISOString().replaceAll(":", "-");
  return join(root, slug(project), slug(environment), `crash-${moment}`);
}

// The run's own log, and one file per step. A build's thousands of lines would
// bury everything else in a single file, and a step's file is what gets opened
// first. Numbered in the order they started, which also keeps two steps that
// share a label from sharing a file
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

// Nothing is written for a deployment that turned it off. Otherwise private to
// whoever ran it: /tmp is shared by everyone on the machine, and a build's output
// can say more than it meant to
export async function dumpCrash(
  config: Deployment,
  transcript: Transcript,
  crash: Crash,
  root = ROOT,
) {
  if (config.options?.crashLog === false) return undefined;

  const directory = crashDirectory(config.project, crash.environment, new Date(crash.at), root);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });

  // Not recursive: a directory already there belongs to another run, and nothing
  // of this one is written into it
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
    return `${file.padEnd(40)} ${step.state.padEnd(8)} ${took}`;
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

// Stamped from the start of the run, the same as run.log, so a line here can be
// found among what the run said around it
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

// Whole, where the terminal gets the tail: the stack of every error in the
// chain, since the step that threw is usually two causes down
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

// Continuation lines line up under the text rather than under the timestamp
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
