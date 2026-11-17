import { useState } from 'react';
import { ideaTopics, maxIdeaScreenshotBytes } from '../shared/pico-ideas';
import { api } from './api';
import { Modal } from './forms';
import { Icon } from './Icons';
import './home-idea.css';

export function HomeIdea({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState<(typeof ideaTopics)[number]>();
  const [text, setText] = useState('');
  const [screenshot, setScreenshot] = useState<{ file: File; preview: string }>();
  const [submissionId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="Идея"
      titleIcon={<Icon name="bulb" />}
      sheet
      closeDisabled={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="pico-home-idea">
        {submitted ? (
          <div className="pico-home-idea-success" role="status">
            <span>
              <Icon name="check" size={36} />
            </span>
            <h3>Спасибо за идею!</h3>
            <p>Мы прочитаем её и ответим вам в боте.</p>
            <button type="button" className="primary" onClick={onClose}>
              На главную
            </button>
          </div>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || reading || !text.trim()) return;
              setBusy(true);
              setError('');
              const form = new FormData();
              form.set('submissionId', submissionId);
              form.set('text', text.trim());
              if (topic) form.set('topic', topic);
              if (screenshot) form.set('screenshot', screenshot.file);
              try {
                await api('/pico-ideas', 'POST', form);
                setSubmitted(true);
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>Как сделать вашу работу проще? Читаем каждое сообщение.</p>
            <div className="pico-home-idea-topics" role="group" aria-label="Тема идеи">
              {ideaTopics.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={topic === value}
                  disabled={busy}
                  onClick={() => setTopic(topic === value ? undefined : value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <textarea
              aria-label="Опишите идею"
              placeholder="Опишите идею"
              value={text}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
            {screenshot ? (
              <div className="pico-home-idea-preview">
                <img src={screenshot.preview} alt="Прикреплённый скриншот" />
                <button
                  type="button"
                  aria-label="Убрать скриншот"
                  disabled={busy}
                  onClick={() => setScreenshot(undefined)}
                >
                  <Icon name="close" />
                </button>
              </div>
            ) : (
              <label className="pico-home-idea-upload">
                <Icon name="file" /> Прикрепить скриншот
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={busy || reading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (
                      !['image/png', 'image/jpeg'].includes(file.type) ||
                      file.size > maxIdeaScreenshotBytes
                    ) {
                      setError('Выберите JPEG или PNG размером до 2 МБ.');
                      return;
                    }
                    setError('');
                    setReading(true);
                    const reader = new FileReader();
                    reader.onload = () => setScreenshot({ file, preview: String(reader.result) });
                    reader.onerror = () => setError('Не удалось открыть скриншот.');
                    reader.onloadend = () => setReading(false);
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy || reading || !text.trim()}>
              {busy ? 'Отправляем…' : 'Отправить'}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}
