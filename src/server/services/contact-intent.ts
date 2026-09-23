const separator = String.raw`[\s,.:;!?—–-]+`;
const boundary = String.raw`(?=$|[\s,.:;!?—–-])`;
const createVerb = String.raw`(?:созда(?:й(?:те)?|ть)|сдела(?:й(?:те)?|ть)|добав(?:ь(?:те)?|ить)|сохран(?:и(?:те)?|ить)|запи(?:ши(?:те)?|сать)|заве(?:ди(?:те)?|сти)|сформир(?:уй(?:те)?|овать))`;
const prefix = String.raw`(?:пожалуйста${separator})?(?:(?:мне${separator})?(?:нужно|надо|(?:я${separator})?хочу|можешь|можете)${separator}(?:мне${separator})?)?(?:пожалуйста${separator})?`;
const contactSubject = String.raw`(?:(?:мне|новый|один|пожалуйста)${separator})*контакт${boundary}([\s\S]*)`;
const requestPattern = String.raw`${prefix}(?:${createVerb}${separator}|(?:мне${separator})?нужен${separator})${contactSubject}`;
const directRequest = new RegExp(`^${requestPattern}$`, 'iu');
const companyFirstRequest = new RegExp(
  String.raw`^(?:пожалуйста${separator})?для${separator}([\s\S]+?)${separator}${requestPattern}$`,
  'iu',
);
// Recognize unsupported bulk requests as commands, never as meeting reports.
const broadContactSubject = String.raw`(?:(?:мне|новый|новые|новых|один|два|две|три|все|всех|несколько|пожалуйста)${separator})*контакт(?:а|ы|ов)?${boundary}([\s\S]*)`;
const broadRequestPattern = String.raw`${prefix}(?:${createVerb}${separator}|(?:мне${separator})?нуж(?:ен|ны)${separator})${broadContactSubject}`;
const broadDirectRequest = new RegExp(`^${broadRequestPattern}$`, 'iu');
const broadCompanyFirstRequest = new RegExp(
  String.raw`^(?:пожалуйста${separator})?для${separator}([\s\S]+?)${separator}${broadRequestPattern}$`,
  'iu',
);
const trimSeparators = (value: string) => value.replace(/^[\s,.:;!?—–-]+|[\s,.:;!?—–-]+$/gu, '');

function detailsWithoutPoliteness(value: string): string {
  return trimSeparators(value)
    .replace(/^пожалуйста(?=$|[\s,.:;!?—–-])[\s,.:;!?—–-]*/iu, '')
    .replace(/(?:^|[\s,.:;!?—–-]+)пожалуйста[\s,.:;!?—–-]*$/iu, '')
    .trim();
}

// A company-first request must still be a command, not a report quoting somebody.
// Restrict only the prefix before the action; contact data can contain ordinary prose.
const unrelatedCompanyClause = new RegExp(
  String.raw`(?:^|[\s,.:;!?—–-])(?:не|нет|никогда|вчера|сегодня|завтра|раньше|уже|потом|если|когда|чтобы|затем|сказал[аи]?|говорил[аи]?|попросил[аи]?|просил[аи]?|обсудил[аи]?|решил[аи]?|создал[аи]?|добавил[аи]?|записал[аи]?|сохранил[аи]?|сделал[аи]?|нужен|нужно|надо|хочу|можешь|можете|${createVerb}|подготов(?:ь(?:те)?|ить)|отправ(?:ь(?:те)?|ить)|удал(?:и(?:те)?|ить)|измен(?:и(?:те)?|ить))${boundary}`,
  'iu',
);

function isCompanyContext(company: string): boolean {
  return !!company && !unrelatedCompanyClause.test(company) && !/[.!?;\n\r]/u.test(company);
}

export function contactCreateRequest(text: string): { details: string } | null {
  const value = text.trim();
  const direct = directRequest.exec(value);
  if (direct) return { details: detailsWithoutPoliteness(direct[1]!) };

  const companyFirst = companyFirstRequest.exec(value);
  if (!companyFirst) return null;
  const company = trimSeparators(companyFirst[1]!);
  if (!isCompanyContext(company)) return null;
  const details = detailsWithoutPoliteness(companyFirst[2]!);
  return { details: `Для ${company}${details ? ` ${details}` : ''}` };
}

export function isContactCreateRequest(text: string): boolean {
  return contactCreateRequest(text) !== null;
}

export function looksLikeContactCommand(text: string): boolean {
  const value = text.trim();
  if (broadDirectRequest.test(value)) return true;
  const companyFirst = broadCompanyFirstRequest.exec(value);
  return !!companyFirst && isCompanyContext(trimSeparators(companyFirst[1]!));
}
