import { useEffect, useState } from 'react';
import { SavedSignature, maxSignatures } from '../shared/letters';
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
  const [editing, setEditing] = useState<SavedSignature | null | undefined>(undefined),
    [deleting, setDeleting] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
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
          key={editing?.id || 'new'}
          initial={editing}
          onCancel={() => (onBack ? onBack() : setEditing(undefined))}
          onSaved={(value) => {
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
          <p>
            Сохранено {items.length} из {maxSignatures}. Подписи доступны только вам.
          </p>
          {items.map((s) => (
            <article className="inset" key={s.id}>
              <strong>{[s.lastName, s.firstName, s.patronymic].filter(Boolean).join(' ')}</strong>
              <p>{[s.workPhone, s.mobilePhone, s.email].filter(Boolean).join(' · ')}</p>
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
