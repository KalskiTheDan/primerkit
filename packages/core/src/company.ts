// A company briefing names its company in its id, as PreReason asks: equities.company/nvda
// (a US ticker or CIK), equities.company/7203 (a Japanese securities code),
// equities.company/005930 (a Korean stock code) or equities.company/ine018a01030 (an Indian
// ISIN), in lower case. Only such a code can follow the slash, never words, so nothing from
// a question travels in it beyond the company it names.
export const COMPANY_FAMILY = 'equities.company';
export const COMPANY_CODE = /^[a-z0-9]{1,12}(?:[.-][a-z0-9]{1,3})?$/;

// The company a briefing id names, or null; the code is read in lower case, as PreReason
// keeps it.
export function companyOf(id: string): string | null {
  if (!id.toLowerCase().startsWith(`${COMPANY_FAMILY}/`)) return null;
  const code = id.slice(COMPANY_FAMILY.length + 1).toLowerCase();
  return COMPANY_CODE.test(code) ? code : null;
}

// A company briefing id in the one spelling PreReason keys it by, or null.
export function companyBriefing(id: string): string | null {
  const code = companyOf(id);
  return code ? `${COMPANY_FAMILY}/${code}` : null;
}

// The market a company's code names, where its shape alone says it, never guessed: a code of
// letters alone is a US ticker (nvda, brk-b), since every other code PreReason reads has a
// digit; an ISIN that starts with IN is an Indian company's. A code of digits alone is a US
// CIK, a Japanese securities code or a Korean stock code, and its market is not known.
export type CompanyMarket = 'usa' | 'india';
export function companyMarket(code: string): CompanyMarket | null {
  if (/^[a-z]+(?:[.-][a-z]{1,3})?$/.test(code)) return 'usa';
  if (/^in[a-z0-9]{9}\d$/.test(code)) return 'india';
  return null;
}

// An equities briefing primerkit does not read: any but a company briefing that names its
// company. The family alone names none.
export function refusedEquities(id: string): boolean {
  return id.startsWith('equities.') && !companyBriefing(id);
}

// Words that ask for a company's figures over several periods: each of its last quarters
// or years, a count of them, the same quarter a year earlier, a history or a trend. For
// such a question primerkit reads the company's statement history (PreReason's numbers
// block with its quarters and fiscal years) in place of the whole briefing, which holds the
// latest period alone. A question about one period ("last quarter", "the quarter that
// ended in December 2009") is not one.
const SERIES: RegExp[] = [
  /\b(?:each|every|all)\s+of\s+(?:its|the|their)\s+(?:last|past|previous|latest|recent)\b/i,
  /\b(?:last|past|previous|prior|recent)\s+(?:\w+\s+)?(?:quarters|years|fiscal years|periods|reports)\b/i,
  /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:\w+\s+)?(?:quarters|years|fiscal years|periods)\b/i,
  /\b(?:a|one|the)\s+year\s+(?:earlier|before|ago)\b|\bsame\s+quarter\b|\byear[- ]over[- ]year\b/i,
  /\b(?:history|historical|over time|trend|quarter by quarter|year by year|since (?:19|20)\d\d)\b/i,
];

export function seriesAsked(question: string): boolean {
  return SERIES.some((re) => re.test(question));
}

// Why an equities id is refused, in the words every refusal uses.
export function equitiesRefusal(id: string): string {
  if (id === COMPANY_FAMILY || id.startsWith(`${COMPANY_FAMILY}/`)) return `${id} names no company: name it in the id, such as ${COMPANY_FAMILY}/nvda, ${COMPANY_FAMILY}/7203 or ${COMPANY_FAMILY}/005930`;
  return `${id} is refused: of the equities briefings, primerkit reads ${COMPANY_FAMILY}/<company> only`;
}
