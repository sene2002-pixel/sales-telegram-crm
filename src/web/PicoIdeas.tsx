import { useState } from 'react';
import './home-idea.css';
import { PicoIdea } from '../shared/pico-ideas';
import { api, download } from './api';

export function PicoIdeas() {
  const [ideas, setIdeas] = useState<PicoIdea[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(next = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<PicoIdea[]>(`/pico-ideas?offset=${next ? (ideas?.length ?? 0) : 0}`);
      setIdeas((existing) => (next ? [...(existing ?? []), ...result] : result));
      setMore(result.length === 30);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Идеи для Pico</h2>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {ideas ? 'Обновить идеи' : 'Загрузить идеи'}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {ideas?.length === 0 && <p>Идей пока нет.</p>}
      {ideas?.map((idea) => (
        <article key={idea.id} className="pico-idea-review">
          <strong>
            {idea.author}
            {idea.topic ? ' · ' + idea.topic : ''}
          </strong>
          <p>{idea.text}</p>
          {idea.screenshotMime && (
            <button
              type="button"
              onClick={() =>
                void download(
                  `/pico-ideas/${idea.id}/screenshot`,
                  idea.screenshotMime === 'image/png' ? 'pico-idea.png' : 'pico-idea.jpg',
                ).catch((cause) => setError(cause.message))
              }
            >
              Скачать скриншот
            </button>
          )}
          {idea.implementedAt ? (
            <p>Внедрено</p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError('');
                try {
                  await api(`/pico-ideas/${idea.id}/implemented`, 'POST');
                  setIdeas(
                    (items) =>
                      items?.map((item) =>
                        item.id === idea.id
                          ? { ...item, implementedAt: new Date().toISOString() }
                          : item,
                      ) ?? null,
                  );
                } catch (cause) {
                  setError((cause as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отметить внедрение
            </button>
          )}
        </article>
      ))}
      {more && (
        <button type="button" disabled={busy} onClick={() => void load(true)}>
          Показать ещё
        </button>
      )}
    </section>
  );
}
