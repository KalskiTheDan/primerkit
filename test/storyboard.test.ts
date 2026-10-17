import { describe, expect, it } from 'vitest';
import { CHARTS } from '@primerkit/session';
import { EXAMPLE_RULES, JOURNEYS, MISSING, speedLines, spread, storyboardHtml, type Drawn, type Speed } from '../scripts/storyboard';

describe('the storyboard', () => {
  it('walks every angle with lines under its screens and a GIF of its steps, the demo first', () => {
    expect(JOURNEYS.map((j) => j.id)).toEqual(['first-five-minutes', 'choosing-a-model', 'asking', 'a-company', 'daily-reader', 'a-later-start', 'rule-builder']);
    expect(JOURNEYS[0]!.data).toBe('demo');
    for (const j of JOURNEYS) {
      expect(j.id).toMatch(/^[a-z-]+$/);
      expect(j.who.length).toBeGreaterThan(40);
      expect(j.steps.filter((s) => s.caption).length).toBeGreaterThanOrEqual(3);
      expect(j.steps.filter((s) => s.hold).length).toBeGreaterThan(2);
      if (j.data === 'live') expect(['model', 'no-model']).toContain(j.home);
    }
    // Choosing a model starts where none is chosen; the rule builder makes its routine first.
    expect(JOURNEYS.find((j) => j.id === 'choosing-a-model')!.home).toBe('no-model');
    expect(JOURNEYS.find((j) => j.id === 'rule-builder')!.routine).toBe(true);
  });

  it('opens a later start in the home the daily reading left, and draws every chart there is', () => {
    const ids = JOURNEYS.map((j) => j.id);
    const later = JOURNEYS.find((j) => j.id === 'a-later-start')!;
    expect(later.homeFrom).toBe('daily-reader');
    expect(ids.indexOf('a-later-start')).toBeGreaterThan(ids.indexOf('daily-reader'));
    expect(later.steps[0]).toMatchObject({ keys: [], caption: expect.stringContaining('a greeting by the hour') });
    const daily = JOURNEYS.find((j) => j.id === 'daily-reader')!;
    for (const chart of CHARTS) expect(daily.steps.some((s) => s.title === `/chart ${chart}`), chart).toBe(true);
    // A company is named by its briefing's id, and a quarter's end is shown read as of now.
    const company = JOURNEYS.find((j) => j.id === 'a-company')!;
    expect(company.steps.filter((s) => s.title.endsWith(', answered')).map((s) => s.title)).toEqual([expect.stringMatching(/^equities\.company\/odfl: /), expect.stringMatching(/quarter ended June 30, 2026\?, answered$/)]);
  });

  it('measures each journey: a screen drawn, its picture, and each answer, as a table', () => {
    expect(spread([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 5, max: 5 });
    expect(spread([])).toEqual({ p50: 0, p95: 0, max: 0 });
    const speeds: Speed[] = [{ journey: 'asking', seconds: 61.2, screens: 40, drawMs: { p50: 0.4, p95: 1.2, max: 3 }, pictureMs: { p50: 9, p95: 30, max: 41 }, answers: [{ question: 'Is it a | b?', seconds: 12.34, tokens: 2_478, checks: '4 of 4', read: ['macro.snapshot'] }] }];
    const lines = speedLines(speeds);
    expect(lines).toContain('| asking | 61.2 s | 40 | 0.4 / 1.2 / 3 | 9 / 30 / 41 |');
    expect(lines).toContain('| asking | Is it a \\| b? | macro.snapshot | 12.3 s | 2,478 | 4 of 4 |');
    const page = storyboardHtml([], MISSING, '2026-10-12 11:00 UTC', speeds);
    expect(page).toContain('<a href="#speed">Speed</a>');
    expect(page).toContain('<tr><td>asking</td><td>61.2 s</td><td>40</td><td>0.4 / 1.2 / 3</td><td>9 / 30 / 41</td></tr>');
    // CONTROL: no speeds, no section.
    expect(storyboardHtml([], MISSING, '2026-10-12 11:00 UTC')).not.toContain('id="speed"');
  });

  it('says the rule builder\'s rules are an example, since primerkit ships none', () => {
    expect(EXAMPLE_RULES).toMatch(/^# Example rules, written for the storyboard\. primerkit ships none\./);
    const builder = JOURNEYS.find((j) => j.id === 'rule-builder')!;
    expect(builder.steps.some((s) => s.caption?.includes('these are an example; primerkit ships none'))).toBe(true);
  });

  it('writes a page that shows each journey and what is not there, escapes every line, and fetches nothing', () => {
    const drawn: Drawn[] = [
      { journey: JOURNEYS[0]!, stills: [{ file: 'first-five-minutes/01-welcome.svg', caption: 'The <b>welcome</b> & "Enter"' }], gif: 'first-five-minutes.gif' },
      { journey: JOURNEYS[2]!, stills: [{ file: 'asking/01-home.svg', caption: 'Home' }], gif: null },
    ];
    const page = storyboardHtml(drawn, MISSING, '2026-10-12 03:30 UTC');
    expect(page).toContain('<a href="#first-five-minutes">The first five minutes</a>');
    expect(page).toContain('<img src="first-five-minutes.gif"');
    // The line under the screen, numbered, and the same words for a reader that cannot see it.
    expect(page).toContain('<figcaption><b>1.</b> The &lt;b&gt;welcome&lt;/b&gt; &amp; &quot;Enter&quot;</figcaption>');
    expect(page).toContain('alt="The &lt;b&gt;welcome&lt;/b&gt; &amp; &quot;Enter&quot;"');
    expect(page).not.toContain('<b>welcome</b>');
    expect(page).toContain('<section id="not-here">');
    for (const m of MISSING) expect(page).toContain(m.title);
    // Every picture is a file beside the page, and nothing is fetched from anywhere.
    const sources = [...page.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);
    expect(sources).toEqual(['first-five-minutes.gif', 'first-five-minutes/01-welcome.svg', 'asking/01-home.svg']);
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/<script|<link/);
  });
});
