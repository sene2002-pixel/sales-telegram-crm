import { CrmRecord } from '../shared/contracts';
import { labels } from '../shared/contracts';
import {
  Deal,
  dealScore,
  directionLabels,
  Fact,
  projectSales,
  salesUpdateSchema,
  SalesUpdate,
  vendorDirections,
} from '../shared/sales';
const fieldLabels: Record<string, string> = {
  amount: 'Сумма нашего оборудования',
  approximate: 'Приблизительная сумма',
  volume: 'Категория объёма',
  due: 'Дата реализации',
  status: 'Статус',
  equipment: 'Потребность',
  budget: 'Бюджет заложен',
  brandApprover: 'Кто согласует бренд',
  purchaser: 'Кто закупает',
  decisionMaker: 'ЛПР (контакт)',
  directAccess: 'Прямой доступ к ЛПР',
  introduction: 'Выход на ЛПР',
  criteria: 'Критерии выбора',
  approvalConditions: 'Условия согласования ESQ',
  approvalDue: 'Срок согласования',
  quoteSent: 'КП направлено',
  quoteDate: 'Дата КП',
  competitorQuoteReceived: 'Конкурентное предложение получено',
  competitor: 'Конкурент',
  alternatives: 'Кого ещё рассматривают',
  offerPosition: 'Позиция нашего предложения',
  blocker: 'Что мешает',
  nextStep: 'Следующий шаг',
  nextDue: 'Срок следующего шага',
  ours: 'Что обещали мы',
  client: 'Что обещал клиент',
  dueAgreement: 'Срок',
  clarify: 'Что уточнить',
};
const values: Record<string, string> = {
  confirmed: 'Подтверждённый объём',
  in_work: 'В работе',
  potential: 'Потенциал',
  implementation: 'В реализации',
  calculation: 'В просчёте',
  tender: 'Тендер',
};
function value(f: Fact<unknown> | undefined): string {
  if (!f || f.value === null) return 'не указано';
  const v =
    typeof f.value === 'boolean'
      ? f.value
        ? 'Да'
        : 'Нет'
      : typeof f.value === 'number'
        ? `${f.value.toLocaleString('ru-RU')} руб.`
        : values[String(f.value)] || String(f.value);
  return `${v}${f.certainty === 'assumption' ? ' (предположение)' : ''}`;
}
export function DealCard({ deal }: { deal: Deal }) {
  const score = dealScore(deal);
  return (
    <article className="sales-deal">
      <h4>
        {deal.name || 'Проект не указан'} · {deal.endCustomer || 'Заказчик не указан'}
      </h4>
      <p>{directionLabels[deal.direction || ''] || 'Направление не указано'}</p>
      <div className="deal-score" role="img" aria-label={`Оценка сделки ${score.score} из 6`}>
        {score.points.map((point, i) => (
          <span key={i} className={point ? 'filled' : ''} aria-hidden="true" />
        ))}
        <strong>{score.score}/6</strong>
      </div>
      <p className="muted">Не хватает: {score.missing.join(', ') || 'все позиции подтверждены'}</p>
      <dl className="sales-fields">
        {Object.entries(deal)
          .filter(([key]) => !['name', 'endCustomer', 'direction'].includes(key))
          .map(([key, f]) => (
            <div key={key}>
              <dt>{fieldLabels[key]}</dt>
              <dd>
                {value(
                  key === 'competitor' && !vendorDirections.has(deal.direction || '')
                    ? null
                    : (f as Fact<unknown>),
                )}
              </dd>
            </div>
          ))}
      </dl>
    </article>
  );
}
export function SalesBlocks({ sales }: { sales: SalesUpdate }) {
  return (
    <section className="sales-blocks" aria-label="Пять блоков CRM">
      <h3>1. Клиент</h3>
      <p>
        Город: {value(sales.client.city)} · Тип:{' '}
        {sales.client.segment?.value
          ? `${labels[sales.client.segment.value]}${sales.client.segment.certainty === 'assumption' ? ' (предположение)' : ''}`
          : 'не указано'}
      </p>
      <p>Филиал: {value(sales.client.branch)}</p>
      {sales.client.disposition && (
        <p>
          {
            { active: 'Активен', unassigned: 'Откреплён', no_potential: 'Без потенциала' }[
              sales.client.disposition.status
            ]
          }{' '}
          · {sales.client.disposition.on} · {sales.client.disposition.reason}
        </p>
      )}
      {sales.client.contacts.map((c, i) => (
        <p key={i}>
          {c.name} · {c.position || 'Должность не указана'} ·{' '}
          {c.decisionRole || 'Роль в решении не указана'}
        </p>
      ))}
      <h3>2. Годовой потенциал по направлениям</h3>
      {!sales.annualPotential.length && <p className="muted">Не указано</p>}
      {sales.annualPotential.map((p, i) => (
        <p key={i}>
          {directionLabels[p.direction]} · {value(p.amount)} · {value(p.equipment)}
          {p.vendor ? ` · Вендор: ${value(p.vendor)}` : ''}
        </p>
      ))}
      <h3>3. Сделки / проекты</h3>
      {!sales.deals.length && (
        <p className="muted">Не оценено: структурированных данных сделки пока нет.</p>
      )}
      {!!sales.deals.length && (
        <div className="table-wrap">
          <table aria-label="Таблица сделок">
            <thead>
              <tr>
                <th>Проект</th>
                <th>Конечный заказчик</th>
                <th>Сумма</th>
                <th>Реализация</th>
                <th>Статус</th>
                <th>Оценка</th>
              </tr>
            </thead>
            <tbody>
              {sales.deals.map((d, i) => (
                <tr key={i}>
                  <td>{d.name || 'не указано'}</td>
                  <td>{d.endCustomer || 'не указано'}</td>
                  <td>{value(d.amount)}</td>
                  <td>{value(d.due)}</td>
                  <td>{value(d.status)}</td>
                  <td>{dealScore(d).score}/6</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sales.deals.map((d, i) => (
        <DealCard key={i} deal={d} />
      ))}
      <h3>4. Дополнительные потребности</h3>
      {!sales.additionalNeeds.length && <p className="muted">Не указано</p>}
      {sales.additionalNeeds.map((n, i) => (
        <p key={i}>
          {directionLabels[n.direction]} · {n.description} · {value(n.amount)} · Вендор:{' '}
          {value(n.vendor)} · {n.on}
        </p>
      ))}
      <h3>5. Договорённости и следующий шаг</h3>
      <dl className="sales-fields">
        {Object.entries(sales.agreements).map(([key, f]) => (
          <div key={key}>
            <dt>{key === 'due' ? 'Срок' : fieldLabels[key]}</dt>
            <dd>{value(f)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function CompanySales({ records }: { records: CrmRecord[] }) {
  const history = records
    .filter((r) => r.kind === 'activity')
    .flatMap((r) => {
      const s = salesUpdateSchema.safeParse(r.data.sales);
      return s.success
        ? [
            {
              id: r.id,
              createdAt: new Date(r.createdAt).toISOString(),
              occurredOn: r.data.occurredOn,
              sales: s.data,
              record: r,
            },
          ]
        : [];
    });
  if (!history.length)
    return <p className="muted">Сделки не оценены: структурированных данных пока нет.</p>;
  const projection = projectSales(history);
  return (
    <>
      {projection.deals.some((d) => d.key.startsWith('ambiguous:')) && (
        <p className="notice" role="status">
          Есть неоднозначная привязка проекта. Укажите конечного заказчика в следующем обновлении;
          эти сведения не объединены с другими сделками.
        </p>
      )}
      <SalesBlocks sales={projection.current} />
      <details>
        <summary>История пяти блоков ({history.length})</summary>
        {[...history].reverse().map((e) => (
          <details key={e.id}>
            <summary>
              {e.occurredOn} · {e.record.authorName} · внесено{' '}
              {new Date(e.createdAt).toLocaleString('ru-RU')}
            </summary>
            <p>
              Источник:{' '}
              {e.record.data.reportId ? `отчёт ${e.record.data.reportId}` : `запись ${e.id}`}
            </p>
            <SalesBlocks sales={e.sales} />
          </details>
        ))}
      </details>
    </>
  );
}
