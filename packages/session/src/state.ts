import type { AnswerView, BenchResult } from '@primerkit/core';
import type { PositionsView } from './positions';
import type { FitnessResult, MachineCheck, ModelSpec, PullProgress } from '@primerkit/models';
import type { BoardRequest } from './board-load';
import type { Board } from './boards';
import type { ComparePlan, CompareResult } from './compare';
import type { DigestView } from './digest';
import type { Menu } from './menu';
import type { NewsRead } from './news';
import type { HypothesisPage, RegistryPage, ResearchPage } from './research';
import type { RoutinePage, RulesPage } from './routine';
import type { ScheduleEntry } from './schedule';

// What the session shows is a function of this state. Keys and finished work change
// the state; the screens only read it.

export type ModelChoice =
  | { kind: 'app'; app: string } // an AI app found on this machine: its own model answers
  | { kind: 'demo' }
  | { kind: 'model'; spec: ModelSpec }
  | { kind: 'kept'; spec: ModelSpec; verdict: string; checkedAt: string; format?: 'json' | 'markdown' } // a model config.yaml keeps, checked and fit: used without a check
  | { kind: 'provider'; provider: string } // then one of its models
  | { kind: 'custom' }; // then a name the person types

export interface Running {
  phase: 'choosing' | 'reading' | 'answering' | 'checking' | 'repairing' | 'working';
  briefings: string[];
  tokens: number | null;
  text?: string; // what a digest or a check is doing now
  stops?: string; // what Ctrl+C does to it, where it keeps what ran
}

export type Entry =
  | { kind: 'running'; question: string; running: Running }
  // A news answer carries its read of PreReason's news, which its credit and lines come from.
  // A sample is the demo stand in's answer to a typed question: it shows no checks line.
  // cost: what the run's model calls cost in dollars, as the run recorded it; absent where not known.
  | { kind: 'answer'; question: string; view: AnswerView; skipped: string[]; notes: string[]; added: string[]; news?: NewsRead; sample?: true; cost?: number }
  | { kind: 'failed'; question: string; message: string; detail: string | null }
  | { kind: 'note'; question: string; text: string }
  | { kind: 'positions'; question: string; view: PositionsView }
  // A read of PreReason's news whose window holds no record.
  | { kind: 'no-records'; question: string; news: NewsRead }
  // What /catalog lists: the briefings this key reads and PreReason's metrics, by area.
  | { kind: 'catalog'; question: string; briefings: Array<{ area: string; ids: string[] }>; metrics: Array<{ area: string; ids: string[] }> | null; saved?: string | null; all?: boolean }
  | { kind: 'digest'; question: string; view: DigestView }
  | { kind: 'check'; question: string; result: FitnessResult }
  | { kind: 'bench'; question: string; result: BenchResult; stopped: string | null }
  | { kind: 'connections'; question: string; prereason: { on: boolean; tier: string | null; saved?: string | null }; alpaca: string; robinhood?: { hosts: string[]; approvals: boolean } }
  | { kind: 'routine'; question: string; page: RoutinePage; made: string | null }
  | { kind: 'rules'; question: string; page: RulesPage }
  | { kind: 'routine-test'; question: string; routine: string; model: string; rows: Array<{ day: string; text: string }>; summary: string; passed: boolean; path: string }
  // The research view: the card with its form check, the hurdle ladder, and the registry.
  | { kind: 'hypothesis'; question: string; page: HypothesisPage }
  | { kind: 'research'; question: string; page: ResearchPage }
  | { kind: 'registry'; question: string; page: RegistryPage }
  // One question answered from the briefings and by the model's web search, side by side.
  | { kind: 'compare'; question: string; result: CompareResult };

export interface CheckLine {
  ok: boolean | null;
  text: string;
}

export interface JournalRow {
  day: string; // "26 Sep"
  time: string; // "14:31"
  operation: string;
  title: string;
  outcome: string;
  dir: string;
}

export type Step =
  | { name: 'welcome' }
  | { name: 'model'; check: MachineCheck | null; choices: ModelChoice[]; cursor: number }
  | { name: 'model-none'; check: MachineCheck }
  | { name: 'model-list'; provider: string; models: string[] | null; error: string | null; cursor: number; typed: string | null }
  | { name: 'model-custom'; stage: 'name' | 'where' | 'url' | 'pull'; typed: string; url: string; cursor: number; pull: PullProgress | null; error: string | null }
  | { name: 'fitness'; label: string; phase: 'confirm' | 'running' | 'done'; plan: { calls: number; tokens: number } | null; lines: CheckLine[]; current: string | null; result: FitnessResult | null; error: string | null }
  | { name: 'connect'; coverage: string | null; link: string | null; phase: 'starting' | 'waiting' | 'failed' | 'demo' | 'tier'; message: string | null }
  | { name: 'first-question'; cursor: number; typed: string | null; entry: Entry | null }
  | { name: 'digest'; stage: 'choose' | 'time' | 'entry' | 'adding' | 'added' | 'failed'; cursor: number; typed: string; entry: ScheduleEntry | null; message: string | null }
  | { name: 'journal'; rows: JournalRow[]; cursor: number; open: { title: string; lines: string[]; top: number } | null; filter?: string }
  | { name: 'install'; app: string; lines: string[]; phase: 'confirm' | 'applying' | 'done' | 'failed' | 'ready'; message: string[] }
  | { name: 'board'; request: BoardRequest; view: { unicode: Board; plain: Board } | null; top: number; status: string; error: string | null }
  // /compare: planned, its cost said, run on Enter, then both answers, scrolled.
  | { name: 'compare'; question: string; phase: 'planning' | 'confirm' | 'running' | 'done'; plan: ComparePlan | null; progress: { briefings: string; web: string; done: { briefings: boolean; web: boolean } } | null; result: CompareResult | null; top: number }
  | { name: 'home' };

// The opening of a later start: the hour it began on this machine's clock, the day of
// the year (which chooses its example question), the model's verdict as config.yaml
// keeps it, whether a digest is scheduled, and the newest run the journal held.
export interface Opening {
  hour: number;
  day: number;
  verdict: string | null;
  scheduled: boolean;
  lastRun: { day: string; time: string; title: string; operation: string } | null;
}

export interface State {
  step: Step;
  firstRun: boolean; // the rail shows during the first run; later the top line does
  demo: { date: string } | null; // the day the demo's saved briefings were served
  schedulerName: string; // where the digest's entry goes: Task Scheduler, launchd or cron
  model: { label: string; name: string; demo: boolean; spec: ModelSpec | null } | null;
  fitness: FitnessResult | null;
  machine: MachineCheck | null;
  connected: boolean;
  tier: string | null;
  callsLeft: number | null;
  dayLimit: number | null;
  runs: number; // the runs the journal holds for today, this session's among them
  recent: JournalRow[]; // the newest runs the journal holds, for the launchpad of a wide window
  watchlist: string[];
  feed: Entry[];
  digest: DigestView | null; // today's digest, shown at the top of home
  opening: Opening | null; // the opening of a later start, over the feed until it gives way
  input: string;
  menu: Menu | null; // the commands under the input while one is typed
  notice: string | null;
  frame: number; // the spinner's frame
  last: string | null; // the last question, for Up
  done: boolean; // the person asked to leave
  size: ScreenSize; // the columns and rows every screen is drawn in
}

// The columns and rows a screen is drawn in, from the window's, never smaller than
// MIN_SIZE (below it the terminal says so instead). Text keeps to the grid's 76 columns,
// where lines read best; a board or chart takes every column the window has.
export interface ScreenSize {
  width: number; // the columns a screen of text is drawn in: the grid's 76, or every column of a wide window
  columns: number; // the window's columns less its last, which a board or chart takes whole
  height: number;
}
export const GRID: ScreenSize = { width: 76, columns: 76, height: 22 };
export const MIN_SIZE = { width: 48, height: 16 };

// The size to draw in for a window `columns` by `rows`: every row it has, and its
// columns less the last, where some terminals wrap a line that reaches it.
// A window of WIDE_COLUMNS or more draws its screens across every column it has: a panel's
// tables and answers take the room, and the grid's 76 columns stay the fallback.
export const WIDE_COLUMNS = 100;
export function sizeFor(columns: number, rows: number): ScreenSize {
  const usable = Math.max(MIN_SIZE.width, columns - 1);
  return { width: usable >= WIDE_COLUMNS ? usable : Math.min(GRID.width, usable), columns: usable, height: Math.max(MIN_SIZE.height, rows) };
}

export function initialState(demo: { date: string } | null, schedulerName = 'the scheduler'): State {
  return {
    step: { name: 'welcome' },
    firstRun: true,
    demo,
    schedulerName,
    model: null,
    fitness: null,
    machine: null,
    connected: false,
    tier: null,
    callsLeft: null,
    dayLimit: null,
    runs: 0,
    recent: [],
    watchlist: [],
    feed: [],
    digest: null,
    opening: null,
    input: '',
    menu: null,
    notice: null,
    frame: 0,
    last: null,
    done: false,
    size: GRID,
  };
}

export type Key =
  | { name: 'enter' | 'escape' | 'up' | 'down' | 'left' | 'right' | 'backspace' | 'tab' | 'ctrl-c' | 'ctrl-d' }
  | { name: 'char'; char: string };
