import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { windowsProgram } from '@primerkit/core';

// The morning digest's entry in the machine's own scheduler: Task
// Scheduler on Windows, launchd on macOS, cron on Linux. The entry is shown in full
// before it is added, /schedule shows it again or removes it, and it runs
// `primerkit run digest` as the person, never as an administrator.

export const TASK_NAME = 'primerkit digest';
const LABEL = 'com.primerkit.digest';

// What an entry runs: the digest, or a routine's forward record. Its name is Task
// Scheduler's task and cron's tag, and its label launchd's.
export interface Job {
  name: string;
  label: string;
  args: string[]; // primerkit's own arguments
  describe: string;
  runs: string; // what a person reads: primerkit run digest
}

export const DIGEST_JOB: Job = { name: TASK_NAME, label: LABEL, args: ['run', 'digest'], describe: "primerkit's morning digest: what changed in your PreReason briefings.", runs: 'primerkit run digest' };

// A routine's forward record, a label a day. `extra` carries --yes where a hosted model
// was agreed to when the entry was added.
export function trackJob(routine: string, extra: string[] = []): Job {
  return {
    name: `primerkit track ${routine}`,
    label: `com.primerkit.track.${routine}`,
    args: ['routine', routine, 'track', ...extra],
    describe: `primerkit's forward record of the routine ${routine}: one label a day, written before its outcome exists. No order goes anywhere.`,
    runs: `primerkit routine ${routine} track`,
  };
}

export type Platform = 'win32' | 'darwin' | 'linux';

export interface EntryOptions {
  time: string; // "08:00", the machine's local time
  platform: Platform;
  node: string; // the node program, process.execPath
  script: string; // the primerkit bin
  cwd: string; // the checkout
  log?: string; // where launchd and cron write what the run prints
  home?: string; // PRIMERKIT_HOME where it is set: the run is told it, as the scheduler starts it without it
  now?: Date;
}

export interface ScheduleEntry {
  name: string;
  where: string; // "Task Scheduler", "launchd", "cron"
  runs: string; // what a person reads: primerkit run digest
  when: string;
  time: string;
  text: string; // the entry exactly as it is written
  platform: Platform;
  log?: string; // the file launchd or cron writes to, whose folder is made when the entry is added
}

export function parseTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The next time the clock reads the time, in local time, as Task Scheduler writes it.
function nextStart(time: string, now: Date): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(h)}:${p(m)}:00`;
}

export function jobEntry(o: EntryOptions, job: Job = DIGEST_JOB): ScheduleEntry {
  const log = o.log ?? join(o.home ?? join(homedir(), '.primerkit'), 'digest', 'scheduled.log');
  const args = o.home ? [...job.args, '--home', o.home] : job.args;
  // An argument with a space or a quote in it is quoted, as Task Scheduler passes the line to
  // node: inside the quotes, backslashes before a quote or before the closing quote are
  // doubled, so a folder ending in \ stays one (Windows' own rule for reading a command line).
  const winArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a);
  if (o.platform === 'win32') {
    const text = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      `    <Description>${xml(job.describe)}</Description>`,
      '  </RegistrationInfo>',
      '  <Triggers>',
      '    <CalendarTrigger>',
      `      <StartBoundary>${nextStart(o.time, o.now ?? new Date())}</StartBoundary>`,
      '      <Enabled>true</Enabled>',
      '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
      '    </CalendarTrigger>',
      '  </Triggers>',
      '  <Principals>',
      '    <Principal id="Author">',
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>',
      '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '  </Settings>',
      '  <Actions Context="Author">',
      '    <Exec>',
      `      <Command>${xml(o.node)}</Command>`,
      `      <Arguments>${xml(`"${o.script}" ${args.map(winArg).join(' ')}`)}</Arguments>`,
      `      <WorkingDirectory>${xml(o.cwd)}</WorkingDirectory>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
    ].join('\r\n');
    return { name: job.name, where: 'Task Scheduler', runs: job.runs, when: `every day at ${o.time}, as you, or on waking if the machine slept`, time: o.time, text, platform: o.platform };
  }
  if (o.platform === 'darwin') {
    const [h, m] = o.time.split(':').map(Number) as [number, number];
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${job.label}</string>`,
      `  <key>ProgramArguments</key><array><string>${xml(o.node)}</string><string>${xml(o.script)}</string>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>`,
      `  <key>WorkingDirectory</key><string>${xml(o.cwd)}</string>`,
      `  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`,
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      '</dict>',
      '</plist>',
    ].join('\n');
    return { name: job.label, where: 'launchd', runs: job.runs, when: `every day at ${o.time}, as you, or on waking if the machine slept`, time: o.time, text, platform: o.platform, log };
  }
  const [h, m] = o.time.split(':').map(Number) as [number, number];
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const word = (a: string) => (/^[A-Za-z0-9._:-]+$/.test(a) ? a : q(a));
  const text = `${m} ${h} * * * cd ${q(o.cwd)} && ${q(o.node)} ${q(o.script)} ${args.map(word).join(' ')} >> ${q(log)} 2>&1 # ${job.name}`;
  return { name: job.name, where: 'cron', runs: job.runs, when: `every day at ${o.time}, as you; cron does not run a time the machine slept through`, time: o.time, text, platform: 'linux', log };
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

// Runs a program without a shell, so nothing in its arguments is read as a command.
export const runCommand: Runner = (command, args, input) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

export const digestEntry = (o: EntryOptions): ScheduleEntry => jobEntry(o, DIGEST_JOB);

export interface Scheduler {
  add(entry: ScheduleEntry): Promise<void>;
  remove(): Promise<boolean>;
  exists(): Promise<boolean>;
}

export function systemScheduler(platform: Platform, run: Runner = runCommand, home = homedir(), job: Job = DIGEST_JOB): Scheduler {
  const TAG = `# ${job.name}`;
  const fail = (what: string, r: CommandResult) => new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  if (platform === 'win32') {
    // Task Scheduler's own command, by its full path, never by a name the current folder could answer to.
    const schtasks = windowsProgram('schtasks.exe');
    return {
      async add(entry) {
        const dir = mkdtempSync(join(tmpdir(), 'primerkit-task-'));
        const file = join(dir, 'task.xml');
        // Task Scheduler reads its XML as UTF-16, with the byte order mark.
        writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(entry.text, 'utf16le')]));
        try {
          const r = await run(schtasks, ['/Create', '/TN', job.name, '/XML', file, '/F']);
          if (r.code !== 0) throw fail('Adding the Task Scheduler entry', r);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      async remove() {
        if (!(await this.exists())) return false;
        const r = await run(schtasks, ['/Delete', '/TN', job.name, '/F']);
        if (r.code !== 0) throw fail('Removing the Task Scheduler entry', r);
        return true;
      },
      async exists() {
        return (await run(schtasks, ['/Query', '/TN', job.name])).code === 0;
      },
    };
  }
  if (platform === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', `${job.label}.plist`);
    const domain = `gui/${userInfo().uid}`;
    return {
      async add(entry) {
        mkdirSync(dirname(plist), { recursive: true });
        if (entry.log) mkdirSync(dirname(entry.log), { recursive: true });
        await run('launchctl', ['bootout', `${domain}/${job.label}`]);
        writeFileSync(plist, entry.text);
        const r = await run('launchctl', ['bootstrap', domain, plist]);
        if (r.code !== 0) throw fail('Adding the launchd job', r);
      },
      async remove() {
        if (!existsSync(plist)) return false;
        await run('launchctl', ['bootout', `${domain}/${job.label}`]);
        unlinkSync(plist);
        return true;
      },
      async exists() {
        return existsSync(plist);
      },
    };
  }
  const current = async () => {
    const r = await run('crontab', ['-l']);
    return r.code === 0 ? r.stdout.split('\n').filter((l) => l.trim()) : [];
  };
  return {
    async add(entry) {
      // cron opens the log before it starts the run, and does not make its folder: a fresh
      // install has none until a digest has run, so the run would never start.
      if (entry.log) mkdirSync(dirname(entry.log), { recursive: true });
      const lines = (await current()).filter((l) => !l.endsWith(TAG));
      const r = await run('crontab', ['-'], [...lines, entry.text].join('\n') + '\n');
      if (r.code !== 0) throw fail('Adding the cron line', r);
    },
    async remove() {
      const lines = await current();
      if (!lines.some((l) => l.endsWith(TAG))) return false;
      const r = await run('crontab', ['-'], lines.filter((l) => !l.endsWith(TAG)).join('\n') + '\n');
      if (r.code !== 0) throw fail('Removing the cron line', r);
      return true;
    },
    async exists() {
      return (await current()).some((l) => l.endsWith(TAG));
    },
  };
}
