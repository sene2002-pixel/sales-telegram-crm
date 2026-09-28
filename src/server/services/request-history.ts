import { Sql } from '../infra/database';

export async function requestEvent(
  tx: Sql,
  reportId: string,
  actionId: string | null,
  event: string,
  data: unknown = {},
) {
  await tx.query(
    `INSERT INTO request_events(report_id,action_id,event,data)
    SELECT report_id,$2,$3,$4 FROM request_history WHERE report_id=$1 AND expires_at>now()`,
    [reportId, actionId, event, JSON.stringify(data)],
  );
}

/** Same request stays ordered. Shared/unknown resources are conservative barriers. */
export function requestsConflict(a: any, b: any): boolean {
  if (a.report_id === b.report_id) return true;
  const ak = a.payload.kind as string,
    bk = b.payload.kind as string;
  const as = ak.startsWith('signature_'),
    bs = bk.startsWith('signature_');
  if (as || bs) return (as && bs) || ak === 'letter' || bk === 'letter';
  if (!a.company?.name || !b.company?.name) return true;
  if (a.company.id && b.company.id) return a.company.id === b.company.id;
  if (a.company.inn && b.company.inn) return a.company.inn === b.company.inn;
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/^(ооо|ао|пао|оао|зао|ип)\s+/u, '');
  return normalize(a.company.name) === normalize(b.company.name);
}
