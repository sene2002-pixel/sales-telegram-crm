import { useEffect, useState } from 'react';
import { SavedSignature, Signature, maxSignatures } from '../shared/letters';
import { api } from './api';
import { SignatureEditor } from './SignatureEditor';
export function SignatureManager({
  createInitially = false,
  onCreated,
  onBack,
}: {
  createInitially?: boolean;
  onCreated?: (value: SavedSignature) => void;
  onBack?: () => void;
}) {
  const [items, setItems] = useState<SavedSignature[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<{ id: string; data: Signature; transcript: string }[]>([]);
  const [draftId, setDraftId] = useState('');
  const [editing, setEditing] = useState<SavedSignature | null | undefined>(undefined),
    [deleting, setDeleting] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api<typeof drafts>('/me/signature-drafts')
      .then((r) => {
        if (active) setDrafts(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    api<SavedSignature[]>('/me/letter-signatures')
      .then((r) => {
        if (active) {
          setItems(r);
          if (createInitially && r.length < maxSignatures) setEditing(null);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section>
      <h2>Подписи для писем</h2>
      <p>
        Можно отправить боту голосовое: «Добавь подпись», затем ФИО, телефоны и email. Черновик
        появится здесь для проверки.
      </p>
      {onBack && editing === undefined && (
        <button disabled={busy} onClick={onBack}>
          Вернуться к письму
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {loading ? (
        <p>Загрузка…</p>
      ) : editing !== undefined ? (
        <SignatureEditor
          key={draftId || editing?.id || 'new'}
          initial={editing}
          draft={drafts.find((d) => d.id === draftId)}
          onCancel={() => {
            setDraftId('');
            onBack ? onBack() : setEditing(undefined);
          }}
          onSaved={(value) => {
            if (draftId) {
              setDrafts((old) => old.filter((d) => d.id !== draftId));
              setDraftId('');
            }
            setItems((old) =>
              old.some((s) => s.id === value.id)
                ? old.map((s) => (s.id === value.id ? value : s))
                : [...old, value],
            );
            setEditing(undefined);
            setMessage('Подпись сохранена.');
            onCreated?.(value);
          }}
        />
      ) : (
        <>
          {drafts.map((d) => (
            <article className="inset" key={d.id}>
              <strong>
                Черновик из голосового:{' '}
                {[d.data.lastName, d.data.firstName].filter(Boolean).join(' ') || 'проверьте имя'}
              </strong>
              <p>Подпись ещё не сохранена. Проверьте телефоны и email.</p>
              <button
                disabled={busy}
                onClick={() => {
                  setDraftId(d.id);
                  setEditing(null);
                }}
              >
                Проверить голосовую подпись
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api(`/me/signature-drafts/${d.id}`, 'DELETE');
                    setDrafts((old) => old.filter((item) => item.id !== d.id));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Отклонить черновик
              </button>
            </article>
          ))}
          <p>
            Сохранено {items.length} из {maxSignatures}. Подписи доступны только вам.
          </p>
          <p>
            Для писем по запросу в Telegram выберите подпись по умолчанию. Если подпись одна, она
            используется автоматически.
          </p>
          {items.map((s) => (
            <article className="inset" key={s.id}>
              <strong>{[s.lastName, s.firstName, s.patronymic].filter(Boolean).join(' ')}</strong>
              <p>{[s.workPhone, s.mobilePhone, s.email].filter(Boolean).join(' · ')}</p>
              <button
                disabled={busy || s.isDefault}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    setItems(
                      await api<SavedSignature[]>(`/me/letter-signatures/${s.id}/default`, 'POST'),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {s.isDefault ? '✓ По умолчанию' : 'Сделать по умолчанию'}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setMessage('');
                  setEditing(s);
                }}
              >
                Редактировать подпись
              </button>
              {deleting === s.id ? (
                <div>
                  <p>Удалить подпись? Уже созданные письма не изменятся.</p>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await api('/me/letter-signatures/' + s.id, 'DELETE');
                        setItems((old) => old.filter((item) => item.id !== s.id));
                        setDeleting('');
                        setMessage('Подпись удалена.');
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Подтвердить удаление
                  </button>
                  <button disabled={busy} onClick={() => setDeleting('')}>
                    Отмена
                  </button>
                </div>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => {
                    setMessage('');
                    setDeleting(s.id);
                  }}
                >
                  Удалить подпись
                </button>
              )}
            </article>
          ))}
          {items.length < maxSignatures ? (
            <button
              disabled={busy}
              onClick={() => {
                setMessage('');
                setEditing(null);
              }}
            >
              + Добавить подпись
            </button>
          ) : (
            <p>Достигнут лимит: 3 подписи. Чтобы добавить новую, удалите одну из сохранённых.</p>
          )}
        </>
      )}
    </section>
  );
}
