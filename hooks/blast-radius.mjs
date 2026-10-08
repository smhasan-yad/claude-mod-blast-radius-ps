// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius PS: Anthropic's Blast Radius sample, extended to the PowerShell
// tool and to Windows.
//
// tool.call (Bash, PowerShell): if the command is risky, work out its blast
// radius, open a pane with Proceed and Cancel, and hold the call until one is
// pressed. On Windows every measurement runs in PowerShell (the `bash` on PATH
// there is often WSL's, which can't see Windows paths), and Git Bash paths such
// as /c/Users/... are translated first.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short sleep process until a button's
// onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "blast-radius";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;
const PS = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

// The call being held, or null. One at a time.
let held = null;
// null until the first risky call asks.
let windows = null;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    return guard($, e, next, "bash");
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: "Blast Radius hit an error while checking this command and did not run it. Do not retry it unless the user asks you to." },
  );

  on("tool.call", { tool: "PowerShell" }, async ($, e, next) => {
    return guard($, e, next, "powershell");
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: "Blast Radius hit an error while checking this command and did not run it. Do not retry it unless the user asks you to." },
  );

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

async function isWindows($) {
  if (windows === null) {
    windows = (await $.env.get("OS")) === "Windows_NT";
  }
  return windows;
}

async function pause($) {
  if (await isWindows($)) {
    await $.process.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 400"], { timeoutMs: 8000 });
  } else {
    await $.process.run(["sleep", "0.25"], { timeoutMs: 5000 });
  }
}

async function guard($, e, next, shell) {
  const command = String(e.command ?? "");
  const risk = shell === "powershell" ? classifyPs(command) : classify(command);
  if (risk === null) {
    return next(e);
  }
  // One hold at a time. `held` is claimed with no await between the check and
  // the claim, so two waiting calls can't both get through.
  while (held !== null) {
    if (next.signal.aborted) {
      return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
    }
    await pause($);
  }
  const mine = { command, shell, risk, report: null, decision: null, where: "pane" };
  held = mine;

  let opened = { isPlaced: false };
  let decision;
  let summary = risk.label;
  try {
    const sessionCwd = await $.session.cwd();
    const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
    mine.report = cwd === null
      ? { summary: `${risk.label} in ${risk.dir}`, lines: [], danger: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
      : await measure($, risk, cwd);
    summary = mine.report.summary;

    // A plain delete of one file, outside the danger zones, isn't worth a stop.
    if (risk.quiet && mine.report.measured && mine.report.files <= 1 && mine.report.dirs === 0 && mine.report.danger.length === 0) {
      mine.decision = "proceed-quiet";
    } else {
      opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await pause($);
      }
    }
  } catch {
    mine.decision = "error"; // anything unexpected refuses the command
  } finally {
    decision = mine.decision;
    try {
      if (opened.isPlaced) {
        await $.ui.close({ id: PANE_ID });
      }
    } catch {
      // the pane is already gone
    }
    if (held === mine) {
      held = null;
    }
    $.ui.invalidate("ui.render");
  }

  if (decision === "proceed-quiet") {
    return next(e);
  }
  if (decision === "proceed") {
    $.ui.toast("Blast Radius: running it");
    return next(e);
  }
  const why = {
    cancel: "the user pressed Cancel",
    timeout: "no answer within 10 minutes",
    interrupted: "the turn was interrupted",
    error: "Blast Radius hit an error while holding it",
  }[decision] ?? "no answer was recorded";
  return {
    deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
  };
}

// ---- What counts as risky: Bash -------------------------------------------

const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

function isAbsolute(arg) {
  return arg.startsWith("/") || arg.startsWith("~") || /^[A-Za-z]:[\\/]?/.test(arg) || arg.startsWith("\\\\");
}

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined) {
    return "~";
  }
  if (isAbsolute(arg)) {
    return arg;
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. */
export function classify(command) {
  let dir = null;
  const scopes = [];
  const pushed = [];
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd;
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop();
    }
  }
  return null;
}

const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

function classifySegment(segment, dir, pushed) {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    words.shift();
  }
  if (words[0] === "sudo") {
    words.shift();
    while (words.length > 0 && words[0].startsWith("-")) {
      const option = words.shift();
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift();
      }
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
    words.shift();
  }
  if (words[0] === "nice") {
    words.shift();
    if (words[0] === "-n") {
      words.splice(0, 2);
    } else if (/^-\d+$/.test(words[0] ?? "")) {
      words.shift();
    }
  }
  const [first, ...args] = words;
  if (first === undefined) {
    return null;
  }
  const cmd = first.replace(/^\\/, "");
  if (cmd === "cd") {
    return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
  }
  if (cmd === "pushd") {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0]) };
  }
  if (cmd === "popd") {
    return { cd: pushed.length > 0 ? pushed.pop() : "-" };
  }
  if (cmd === "rm" || cmd.endsWith("/rm")) {
    const flags = args.filter((a) => a.startsWith("-"));
    const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
    const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
    if (recursive || force) {
      const targets = args.filter((a) => !a.startsWith("-") || a === "-").map((path) => ({ path, literal: !/[*?]/.test(path) }));
      return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
    }
  }
  if (cmd === "git") {
    return gitRisk(args, dir);
  }
  const joined = words.join(" ");
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
  }
  if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
    return { kind: "migrate", tool: "unknown", label: "migrate", dir };
  }
  return null;
}

/** git's risky subcommands, shared by both shells. */
function gitRisk(args, dir) {
  let gitDir = dir;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C" && i + 1 < args.length) {
      gitDir = joinDir(gitDir, args[i + 1]);
      i += 2;
    } else if (args[i] === "-c" && i + 1 < args.length) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "reset" && rest.includes("--hard")) {
    return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
  }
  if (sub === "clean") {
    return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
  }
  if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
    return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
  }
  const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
  if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
    return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
  }
  return null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- What counts as risky: PowerShell -------------------------------------

const PS_DELETE = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const PS_CD = new Set(["cd", "chdir", "set-location", "sl"]);
const PS_PUSH = new Set(["pushd", "push-location"]);
const PS_POP = new Set(["popd", "pop-location"]);
const PS_LISTERS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi"]);
// Remove-Item parameters that take a value, by the shortest prefix PowerShell accepts.
const PS_VALUE_PARAMS = ["path", "literalpath", "pspath", "lp", "include", "exclude", "filter", "credential", "stream"];

/** PowerShell words, honouring "..." (backtick escapes) and '...' ('' escapes). Comma-joined words are marked. */
function tokenizePs(text) {
  const words = [];
  const re = /"((?:[^"`]|`.)*)"|'((?:[^']|'')*)'|(,)|([^\s,]+)/g;
  let m;
  let joined = false;
  while ((m = re.exec(text)) !== null) {
    if (m[3] !== undefined) {
      joined = true;
      continue;
    }
    const value = m[1] !== undefined ? m[1].replace(/`(.)/g, "$1") : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[4];
    words.push({ value, quoted: m[4] === undefined, joined });
    joined = false;
  }
  return words;
}

/** Which named parameter `word` is (`-Path:x` too), or null for a positional word. */
function psParam(word) {
  if (word.quoted || !/^-[A-Za-z]/.test(word.value)) {
    return null;
  }
  const m = word.value.match(/^-([A-Za-z]+)(?::(.*))?$/);
  if (!m) {
    return null;
  }
  return { name: m[1].toLowerCase(), inline: m[2] };
}

function matchesParam(name, full, min) {
  return name.length >= min && full.startsWith(name);
}

/** Reads a Remove-Item call's paths and switches. */
function parseRemoveItem(words) {
  const targets = [];
  const filters = [];
  let recurse = false;
  let force = false;
  let whatIf = false;
  for (let i = 0; i < words.length; i += 1) {
    const p = psParam(words[i]);
    if (p === null) {
      targets.push({ path: words[i].value, literal: false });
      continue;
    }
    if (matchesParam(p.name, "recurse", 1)) {
      recurse = true;
      continue;
    }
    if (matchesParam(p.name, "force", 2)) {
      force = true;
      continue;
    }
    if (matchesParam(p.name, "whatif", 2) || p.name === "wi") {
      whatIf = true;
      continue;
    }
    const takesValue = PS_VALUE_PARAMS.find((full) => full === p.name || (p.name.length >= 2 && full.startsWith(p.name)));
    if (takesValue === undefined) {
      continue; // -Confirm, -Verbose and friends
    }
    const values = [];
    if (p.inline !== undefined && p.inline !== "") {
      values.push(p.inline);
    } else if (i + 1 < words.length) {
      i += 1;
      values.push(words[i].value);
    }
    while (i + 1 < words.length && words[i + 1].joined) {
      i += 1;
      values.push(words[i].value);
    }
    const literal = takesValue === "literalpath" || takesValue === "pspath" || takesValue === "lp";
    if (takesValue === "path" || literal) {
      for (const v of values) {
        targets.push({ path: v, literal });
      }
    } else if (takesValue === "include" || takesValue === "exclude" || takesValue === "filter") {
      filters.push(`-${takesValue} ${values.join(",")}`);
    }
  }
  // Comma-joined positionals: Remove-Item a, b
  return { targets, filters, recurse, force, whatIf };
}

/** The first path a Get-ChildItem-style lister names, for a piped Remove-Item. */
function listerTarget(words) {
  for (let i = 0; i < words.length; i += 1) {
    const p = psParam(words[i]);
    if (p === null) {
      return { path: words[i].value, literal: false };
    }
    if ((p.name === "path" || p.name === "literalpath" || p.name === "lp") && i + 1 < words.length) {
      return { path: p.inline || words[i + 1].value, literal: p.name !== "path" };
    }
  }
  return { path: ".", literal: true };
}

/** The first risky segment of a PowerShell command, or null. */
export function classifyPs(command) {
  let dir = null;
  const pushed = [];
  // Statements split on ; && || and newlines; pipelines on |.
  for (const statement of command.split(/&&|\|\||;|\r?\n/)) {
    const stages = statement.split("|");
    let previous = null;
    for (const stage of stages) {
      const words = tokenizePs(stage.trim().replace(/^[({&.]+\s*/, "").replace(/\s*[)}]+$/, ""));
      const risk = classifyPsStage(words, dir, pushed, previous, stage);
      if (risk !== null && risk.cd === undefined) {
        return risk;
      }
      if (risk !== null) {
        dir = risk.cd;
      }
      previous = words;
    }
  }
  return null;
}

function classifyPsStage(words, dir, pushed, previous, raw) {
  if (words.length === 0) {
    return null;
  }
  const cmd = words[0].value.toLowerCase().replace(/\.exe$/, "");
  const args = words.slice(1);
  if (PS_CD.has(cmd) || PS_PUSH.has(cmd)) {
    const named = args.findIndex((w) => /^-(path|literalpath|lp)$/i.test(w.value));
    const target = named >= 0 ? args[named + 1]?.value : args.find((w) => psParam(w) === null)?.value;
    if (PS_PUSH.has(cmd)) {
      pushed.push(dir);
    }
    return { cd: target === "-" ? "-" : joinDir(dir, target) };
  }
  if (PS_POP.has(cmd)) {
    return { cd: pushed.length > 0 ? pushed.pop() : "-" };
  }
  if (cmd === "git") {
    return gitRisk(args.map((w) => w.value), dir);
  }
  if (cmd === "cmd" && args.some((w) => /^\/[ck]$/i.test(w.value))) {
    const at = args.findIndex((w) => /^\/[ck]$/i.test(w.value));
    const inner = args.slice(at + 1).map((w) => w.value).join(" ");
    return classifyCmd(tokenizePs(inner), dir);
  }
  if (PS_DELETE.has(cmd)) {
    const parsed = parseRemoveItem(args);
    if (parsed.whatIf) {
      return null; // a dry run deletes nothing
    }
    let targets = parsed.targets;
    let piped = false;
    if (targets.length === 0 && previous !== null && previous.length > 0 && PS_LISTERS.has(previous[0].value.toLowerCase())) {
      targets = [listerTarget(previous.slice(1))];
      piped = true;
    }
    const flags = [parsed.recurse ? "-Recurse" : "", parsed.force ? "-Force" : "", ...parsed.filters].filter(Boolean);
    const wild = targets.some((t) => !t.literal && /[*?]/.test(t.path));
    return {
      kind: "rm",
      label: `${words[0].value} ${flags.join(" ")}`.trim(),
      targets,
      dir,
      piped,
      unknownTargets: targets.length === 0,
      // Without -Recurse, -Force or a wildcard, only stop when it turns out to be more than one plain file.
      quiet: !parsed.recurse && !parsed.force && !wild && !piped && targets.length > 0,
    };
  }
  // A delete inside a script block (ForEach-Object { Remove-Item $_ -Recurse }) can't be listed, but it is still held.
  if (/\{[^}]*\b(remove-item|ri|rm|rmdir|rd|del|erase)\b/i.test(raw)) {
    return { kind: "rm", label: "delete inside a script block", targets: [], dir, unknownTargets: true };
  }
  return null;
}

/** cmd.exe's rd /s and del /s, reached through cmd /c. */
function classifyCmd(words, dir) {
  if (words.length === 0) {
    return null;
  }
  const cmd = words[0].value.toLowerCase();
  const rest = words.slice(1).map((w) => w.value);
  const switches = rest.filter((a) => /^\/[a-z]$/i.test(a)).map((a) => a.toLowerCase());
  const paths = rest.filter((a) => !/^\/[a-z]$/i.test(a));
  if ((cmd === "rd" || cmd === "rmdir") && switches.includes("/s")) {
    return { kind: "rm", label: `${cmd} ${switches.join(" ")}`, targets: paths.map((path) => ({ path, literal: true })), dir };
  }
  if ((cmd === "del" || cmd === "erase") && (switches.includes("/s") || paths.some((p) => /[*?]/.test(p)))) {
    return { kind: "rm", label: `${cmd} ${switches.join(" ")}`.trim(), targets: paths.map((path) => ({ path, literal: !/[*?]/.test(path) })), dir };
  }
  return null;
}

// ---- Resolving folders -----------------------------------------------------

// Translates ~, $HOME, $env:NAME and Git Bash's /c/... to Windows paths. Any other
// $ is left in place and reported as unresolved: nothing in a path is ever run.
const PS_NORM = String.raw`
function Norm([string]$p) {
  if ($p -eq '~') { return $HOME }
  if ($p -match '^~[\\/]') { return (Join-Path $HOME $p.Substring(2)) }
  if ($p -match '^\$HOME($|[\\/])') { $p = $HOME + $p.Substring(5) }
  if ($p -match '^/([a-zA-Z])/(.*)$') { return ($Matches[1].ToUpper() + ':\' + ($Matches[2] -replace '/', '\')) }
  if ($p -match '^/([a-zA-Z])$') { return ($Matches[1].ToUpper() + ':\') }
  $p = [regex]::Replace($p, '\$env:([A-Za-z_][A-Za-z0-9_]*)', { param($m) [Environment]::GetEnvironmentVariable($m.Groups[1].Value) })
  return $p
}
`;

const PS_CD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
` + PS_NORM + String.raw`
try {
  Set-Location -LiteralPath (Norm $in.base)
  $d = Norm $in.dir
  if ($d -match '\$') { exit 1 }
  Set-Location -Path $d
  (Get-Location).ProviderPath
} catch { exit 1 }
`;

const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null;
  }
  if (await isWindows($)) {
    const run = await $.process.run([...PS, PS_CD_SCRIPT], { cwd: sessionCwd, stdin: JSON.stringify({ base: sessionCwd, dir }), timeoutMs: 15000 });
    const out = run.stdout.trim();
    return run.exitCode === 0 && out !== "" ? out : null;
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

// ---- Measuring the blast radius -------------------------------------------

async function measure($, risk, cwd) {
  try {
    let report;
    if (risk.kind === "rm") {
      report = (await isWindows($)) ? await measureRmWindows($, risk, cwd) : await measureRm($, risk, cwd);
    } else if (risk.kind === "migrate") {
      report = await measureMigrations($, risk, cwd);
    } else {
      report = await measureGit($, risk, cwd);
    }
    return { danger: [], ...report };
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], danger: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

// Measures paths in PowerShell. Paths come in on stdin as JSON, never as source.
const PS_RM_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
` + PS_NORM + String.raw`
Set-Location -LiteralPath (Norm $in.cwd)
$items = New-Object System.Collections.ArrayList
$unresolved = @()
foreach ($t in $in.targets) {
  $p = Norm $t.path
  if ($p -match '\$') { $unresolved += $t.path; continue }
  if ($t.literal -or $p -notmatch '[*?]') {
    if (Test-Path -LiteralPath $p) { [void]$items.Add((Get-Item -LiteralPath $p -Force)) }
  } else {
    foreach ($r in (Resolve-Path -Path $p)) { [void]$items.Add((Get-Item -LiteralPath $r.ProviderPath -Force)) }
  }
}
$files = 0; $bytes = [long]0; $dirs = 0; $list = New-Object System.Collections.ArrayList
$danger = New-Object System.Collections.ArrayList
$homeDir = $HOME.TrimEnd('\')
$deadline = (Get-Date).AddSeconds(12); $partial = $false
# Streams the walk so the deadline holds on huge trees; skips junctions and links.
function Walk([string]$root) {
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $d = New-Object System.IO.DirectoryInfo ($stack.Pop())
    try {
      foreach ($f in $d.EnumerateFiles()) {
        $script:files++; $script:bytes += $f.Length
        if ($script:list.Count -lt ${LIST_MAX}) { [void]$script:list.Add($f.FullName) }
        if ((Get-Date) -gt $script:deadline) { $script:partial = $true; return }
      }
    } catch {}
    try {
      foreach ($s in $d.EnumerateDirectories()) {
        if (-not ($s.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $stack.Push($s.FullName) }
      }
    } catch {}
  }
}
foreach ($it in $items) {
  $full = $it.FullName.TrimEnd('\')
  if ($full -match '\\My Drive(\\|$)' -or $full -match '^G:(\\|$)') { [void]$danger.Add("Google Drive: $full (not in git, a mistake here syncs to every machine)") }
  if ($full -ieq $homeDir) { [void]$danger.Add("your whole home folder: $full") }
  elseif ((Split-Path $full -Parent).TrimEnd('\') -ieq $homeDir) { [void]$danger.Add("a top-level folder of your home: $full") }
  if ($full -match '^[A-Za-z]:$') { [void]$danger.Add("a whole drive: $full") }
  if ($full -match '^[A-Za-z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData)(\\|$)') { [void]$danger.Add("a system folder: $full") }
  if ($it.PSIsContainer) {
    $dirs++
    Walk $it.FullName
  } else {
    $files++; $bytes += $it.Length
    if ($list.Count -lt ${LIST_MAX}) { [void]$list.Add($it.FullName) }
  }
  if ($partial) { break }
}
$out = @{ found = $items.Count; files = $files; bytes = $bytes; dirs = $dirs; list = @($list); danger = @($danger | Select-Object -Unique); unresolved = @($unresolved); partial = $partial; cwd = (Get-Location).ProviderPath }
$out | ConvertTo-Json -Compress -Depth 4
`;

function relativeTo(cwd, path) {
  const base = cwd.replace(/[\\/]+$/, "").toLowerCase() + "\\";
  return path.toLowerCase().startsWith(base) ? path.slice(base.length) : path;
}

async function measureRmWindows($, risk, cwd) {
  if (risk.targets.length === 0) {
    return {
      summary: `${risk.label}: targets come from a variable or loop`,
      lines: [],
      measured: false,
      note: "I can't list what this would delete, because the paths aren't written out in the command. Read the command before you press Proceed.",
    };
  }
  const run = await $.process.run([...PS, PS_RM_SCRIPT], { cwd, stdin: JSON.stringify({ cwd, targets: risk.targets }), timeoutMs: 30000 });
  const json = run.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let r;
  try {
    r = JSON.parse(json);
  } catch {
    return { summary: `${risk.label} (could not measure it)`, lines: [], measured: false, note: `Could not measure: ${run.stderr.trim().slice(0, 200) || "no output from PowerShell"}` };
  }
  const shown = risk.targets.map((t) => t.path).join(" ");
  const pipedNote = risk.piped ? " Paths come from the command piped into it; filters on that command are not applied here, so this is the most it could delete." : "";
  const unresolvedNote = r.unresolved.length ? ` Couldn't read: ${r.unresolved.join(", ")}.` : "";
  if (!r.found) {
    return {
      summary: `delete nothing: no file matches ${shown}`,
      lines: [],
      measured: r.unresolved.length === 0,
      files: 0,
      dirs: 0,
      danger: r.danger,
      note: `The paths don't exist here (${r.cwd}).${unresolvedNote}`,
    };
  }
  const more = Math.max(0, r.files - r.list.length);
  return {
    summary: r.files === 0
      ? `delete ${r.found} ${r.found === 1 ? "path" : "paths"} with no files in ${r.found === 1 ? "it" : "them"}`
      : `delete ${r.partial ? "at least " : ""}${r.files} ${r.files === 1 ? "file" : "files"} (about ${size(r.bytes)})`,
    lines: r.list.map((l) => relativeTo(r.cwd, l)),
    more,
    measured: r.unresolved.length === 0 && !risk.piped,
    files: r.files,
    dirs: r.dirs,
    danger: r.danger,
    note: `Paths: ${shown}.${pipedNote}${unresolvedNote}${r.partial ? " Counting stopped after 12 s." : ""}`,
  };
}

const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], measured: false, note: "No paths to expand." };
  }
  const paths = risk.targets.map((t) => t.path);
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-radius", ...paths], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  if (!found) {
    return { summary: `delete nothing: no file matches ${paths.join(" ")}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${paths.join(" ")}` };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${paths.join(" ")}`,
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, "");
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch || branch === "HEAD") {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(28, 9 + report.lines.length + (report.more ? 1 : 0) + (report.danger?.length ?? 0));
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const danger = report.danger ?? [];
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  const tone = danger.length > 0 ? "red" : "yellow";
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: tone,
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: tone, children: `⚠ Blast Radius · ${state.shell === "powershell" ? "PowerShell" : "Bash"} · ${state.risk.label}` }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })], wrap: "truncate-end" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })] }),
      danger.length > 0
        ? Box({
          key: "danger",
          flexDirection: "column",
          marginTop: 1,
          children: danger.map((d, i) => Text({ key: `d${i}`, color: "red", bold: true, children: `‼ ${d}`, wrap: "wrap" })),
        })
        : null,
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, wrap: "wrap", children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
