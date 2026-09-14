import { useEffect, useState } from 'react';
import {
  Company,
  Extraction,
  Report,
  labels,
  divisions,
  segments,
  stages,
} from '../shared/contracts';
import { api } from './api';
import { Field, Modal, Select } from './forms';

export function Reports({
  companies,
  onChanged,
}: {
  companies: Company[];
  onChanged: () => Promise<void>;
}) {
  const [reports, setReports] = useState<Report[]>([]),
    [selected, setSelected] = useState<string | null>(
      new URLSearchParams(location.search).get('report'),
    );
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setReports(await api('/reports'));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">ГОЛОС → ДЕЙСТВИЕ</p>
          <h1>Отчёты</h1>
        </div>
        <span className="count">{reports.length}</span>
      </div>
      <section className="panel">
        <h3>Зафиксировать результат разговора</h3>
        <p className="muted">
          Надиктуйте боту или отправьте текст здесь. Сначала вы получите черновик для проверки.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const r = await api('/reports', 'POST', { text, requestId: crypto.randomUUID() });
              setText('');
              setSelected(r.id);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Текст отчёта">
            <textarea
              rows={3}
              required
              maxLength={20000}
              placeholder="Обсудили с Иваном из Электростроя поставку оборудования. Завтра отправить предложение…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <button disabled={busy} className="primary">
            {busy ? 'Отправляем…' : 'Подготовить черновик'}
          </button>
        </form>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="list">
        {reports.map((r) => (
          <button className="report-row" key={r.id} onClick={() => setSelected(r.id)}>
            <span className={'status ' + r.status}>{labels[r.status]}</span>
            <strong>
              {r.draft?.blocks.map((b) => b.companyName).join(', ') ||
                r.transcript?.slice(0, 80) ||
                'Голосовой отчёт'}
            </strong>
            <small>
              {r.authorName} · {new Date(r.createdAt).toLocaleString('ru-RU')}
            </small>
            {r.error && <span className="error">{r.error}</span>}
          </button>
        ))}
      </div>
      {!reports.length && <div className="empty">Здесь появятся ваши отчёты и черновики.</div>}
      {selected && (
        <ReportEditor
          id={selected}
          companies={companies}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            await refresh();
            await onChanged();
          }}
        />
      )}
    </>
  );
}
function ReportEditor({
  id,
  companies,
  onClose,
  onChanged,
}: {
  id: string;
  companies: Company[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [report, setReport] = useState<Report | null>(null),
    [draft, setDraft] = useState<Extraction | null>(null),
    [ids, setIds] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    const r = await api<Report & { candidates: string[][] }>(`/reports/${id}`);
    setReport(r);
    setDraft(r.draft);
    setIds(r.candidates.map((g) => (g.length === 1 ? g[0]! : null)));
    return r;
  }
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const r = await api<Report & { candidates: string[][] }>(`/reports/${id}`);
        if (!alive) return;
        setReport(r);
        setDraft(r.draft);
        setIds(r.candidates.map((g) => (g.length === 1 ? g[0]! : null)));
        if (['queued', 'processing'].includes(r.status)) timer = setTimeout(poll, 2500);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const update = (i: number, key: string, value: any) =>
    setDraft(
      (p) => p && { ...p, blocks: p.blocks.map((b, n) => (n === i ? { ...b, [key]: value } : b)) },
    );
  return (
    <Modal title="Проверка отчёта" onClose={onClose}>
      {report && (
        <p>
          <span className={'status ' + report.status}>{labels[report.status]}</span>{' '}
          <small>{new Date(report.createdAt).toLocaleString('ru-RU')}</small>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report?.error && <p className="error">{report.error}</p>}
      {report?.transcript && (
        <details>
          <summary>Исходная транскрипция</summary>
          <p className="preserve">{report.transcript}</p>
        </details>
      )}
      {draft && draft.warnings.length > 0 && (
        <div className="notice">
          {draft.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      {draft && report?.status === 'review' && (
        <>
          <p className="muted">
            Проверьте компании, суммы и сроки. Сохранение применит все блоки одновременно.
          </p>
          {draft.blocks.map((b, i) => (
            <section className="inset" key={i}>
              <h3>
                {i + 1}. {b.companyName}
              </h3>
              <Field label="Записать в компанию">
                <select
                  value={ids[i] || ''}
                  onChange={(e) =>
                    setIds((p) => p.map((v, n) => (n === i ? e.target.value || null : v)))
                  }
                >
                  <option value="">Создать новую компанию</option>
                  {companies
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.inn || c.city} · {c.ownerName}
                      </option>
                    ))}
                </select>
              </Field>
              {!ids[i] && (
                <div className="form-grid">
                  <Field label="Название компании">
                    <input
                      value={b.companyName}
                      onChange={(e) => update(i, 'companyName', e.target.value)}
                    />
                  </Field>
                  <Field label="ИНН">
                    <input
                      value={b.inn || ''}
                      onChange={(e) => update(i, 'inn', e.target.value || null)}
                    />
                  </Field>
                  <Field label="Город">
                    <input
                      value={b.city || ''}
                      onChange={(e) => update(i, 'city', e.target.value || null)}
                    />
                  </Field>
                  <Field label="Сегмент">
                    <Select
                      value={b.segment || ''}
                      options={segments}
                      empty="Не указан"
                      onChange={(v) => update(i, 'segment', v || null)}
                    />
                  </Field>
                </div>
              )}
              <div className="form-grid">
                <Field label="Дата общения">
                  <input
                    type="date"
                    value={b.occurredOn}
                    onChange={(e) => update(i, 'occurredOn', e.target.value)}
                  />
                </Field>
                <Field label="Стадия">
                  <Select
                    value={b.stage || ''}
                    options={stages}
                    empty="Не изменять"
                    onChange={(v) => update(i, 'stage', v || null)}
                  />
                </Field>
                <Field label="Потенциал, ₽">
                  <input
                    type="number"
                    min="0"
                    value={b.potential ?? ''}
                    onChange={(e) =>
                      update(i, 'potential', e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </Field>
              </div>
              <Field label="Результат общения">
                <textarea
                  rows={3}
                  value={b.summary}
                  onChange={(e) => update(i, 'summary', e.target.value)}
                />
              </Field>
              <h4>Направления</h4>
              {b.divisions.map((d, n) => (
                <div className="inline-fields" key={n}>
                  <Select
                    value={d.key}
                    options={divisions}
                    onChange={(v) =>
                      update(
                        i,
                        'divisions',
                        b.divisions.map((x, j) => (j === n ? { ...x, key: v } : x)),
                      )
                    }
                  />
                  <input
                    aria-label="Сумма направления"
                    type="number"
                    min="0"
                    value={d.amount}
                    onChange={(e) =>
                      update(
                        i,
                        'divisions',
                        b.divisions.map((x, j) =>
                          j === n ? { ...x, amount: Number(e.target.value) } : x,
                        ),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      update(
                        i,
                        'divisions',
                        b.divisions.filter((_, j) => j !== n),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => update(i, 'divisions', [...b.divisions, { key: 'lv', amount: 0 }])}
              >
                + Направление
              </button>
              <h4>Контакты</h4>
              {b.contacts.map((c, n) => (
                <div className="inset" key={n}>
                  <div className="form-grid">
                    {(['name', 'role', 'phone', 'email'] as const).map((k) => (
                      <Field
                        key={k}
                        label={
                          { name: 'Имя', role: 'Должность', phone: 'Телефон', email: 'Email' }[k]
                        }
                      >
                        <input
                          value={c[k] || ''}
                          onChange={(e) =>
                            update(
                              i,
                              'contacts',
                              b.contacts.map((x, j) =>
                                j === n
                                  ? { ...x, [k]: e.target.value || (k === 'name' ? '' : null) }
                                  : x,
                              ),
                            )
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      update(
                        i,
                        'contacts',
                        b.contacts.filter((_, j) => j !== n),
                      )
                    }
                  >
                    Убрать контакт
                  </button>
                </div>
              ))}
              <button
                onClick={() =>
                  update(i, 'contacts', [
                    ...b.contacts,
                    { name: '', role: null, phone: null, email: null },
                  ])
                }
              >
                + Контакт
              </button>
              <h4>Следующие шаги</h4>
              {b.tasks.map((t, n) => (
                <div className="inline-fields" key={n}>
                  <input
                    aria-label="Текст задачи"
                    value={t.text}
                    onChange={(e) =>
                      update(
                        i,
                        'tasks',
                        b.tasks.map((x, j) => (j === n ? { ...x, text: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    aria-label="Срок задачи"
                    type="date"
                    value={t.due || ''}
                    onChange={(e) =>
                      update(
                        i,
                        'tasks',
                        b.tasks.map((x, j) =>
                          j === n ? { ...x, due: e.target.value || null } : x,
                        ),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      update(
                        i,
                        'tasks',
                        b.tasks.filter((_, j) => j !== n),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button onClick={() => update(i, 'tasks', [...b.tasks, { text: '', due: null }])}>
                + Задача
              </button>
            </section>
          ))}
          <div className="actions sticky">
            <button
              disabled={busy}
              className="primary"
              onClick={() =>
                run(() =>
                  api(`/reports/${id}/confirm`, 'POST', {
                    version: report.version,
                    draft,
                    companyIds: ids,
                  }),
                )
              }
            >
              Подтвердить и сохранить
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(() => api(`/reports/${id}`, 'PATCH', { version: report.version, draft }))
              }
            >
              Сохранить черновик
            </button>
          </div>
        </>
      )}
      {report?.status === 'saved' && (
        <div className="success">Отчёт сохранён. Записи доступны в карточках компаний.</div>
      )}
      {report && ['queued', 'processing'].includes(report.status) && (
        <p className="empty">Подготавливаем черновик… Страница обновится автоматически.</p>
      )}
      {report?.status === 'failed' && (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api(`/reports/${id}/retry`, 'POST');
              onClose();
            })
          }
        >
          Повторить обработку
        </button>
      )}
      {report && ['queued', 'review', 'failed'].includes(report.status) && (
        <button
          disabled={busy}
          className="text-button"
          onClick={() => run(() => api(`/reports/${id}/cancel`, 'POST'))}
        >
          Отменить отчёт
        </button>
      )}
    </Modal>
  );
}
