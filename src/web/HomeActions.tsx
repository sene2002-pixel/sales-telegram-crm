import { useEffect, useRef, useState } from 'react';
import type { Actor } from '../shared/contracts';
import picoAvatar from '../../public/brand/pico-avatar.png';
import { api } from './api';
import { Field, Modal } from './forms';
import { Icon } from './Icons';
import './home-actions.css';

const shareTitle = 'Поделиться';
const shareDescription = 'Коллеги скажут вам спасибо';
const defaultMessage = 'Я веду здесь задачи и клиентов. Возможно, вам тоже будет удобно';
const cardStep = 179;
type HomeActionsProps = {
  user: Actor;
  users: Actor[];
  onSupport: () => void;
  onIdea: () => void;
};
type InvitationLink = { id: string; url: string; expiresAt: string };
type InvitationState = { id: string; usedAt: string | null; revokedAt: string | null };

export function HomeActions(props: HomeActionsProps) {
  return <AccountHomeActions key={`${props.user.id}:${props.user.role}`} {...props} />;
}

function AccountHomeActions({ user, users, onSupport, onIdea }: HomeActionsProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [pagination, setPagination] = useState({ count: 1, selected: 0 });
  const carousel = useRef<HTMLDivElement>(null);
  const invites = useRef(new Map<string, InvitationLink>());
  const publicLink = useRef('');
  const draftKey = `pico-share-message:${user.id}`;
  const [message, setMessage] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? defaultMessage;
    } catch {
      return defaultMessage;
    }
  });

  useEffect(() => {
    const track = carousel.current!;
    const update = () => {
      const end = track.scrollWidth - track.clientWidth;
      const count = Math.ceil(end / cardStep) + 1;
      const selected =
        end - track.scrollLeft <= 1 ? count - 1 : Math.round(track.scrollLeft / cardStep);
      setPagination((current) =>
        current.count === count && current.selected === selected ? current : { count, selected },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(track);
    track.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      track.removeEventListener('scroll', update);
    };
  }, []);

  async function getLink(supervisorId: string) {
    if (user.role === 'manager') {
      if (publicLink.current) return publicLink.current;
      const { url } = await api<{ url: string }>('/share/bot-link');
      if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}$/.test(url))
        throw new Error('Ссылка Telegram недоступна. Попробуйте позже.');
      publicLink.current = url;
      return url;
    }
    const saved = invites.current.get(supervisorId);
    if (saved && Date.parse(saved.expiresAt) > Date.now()) {
      const invitations = await api<InvitationState[]>('/team-invitations');
      const status = invitations.find((item) => item.id === saved.id);
      if (status && !status.usedAt && !status.revokedAt && Date.parse(saved.expiresAt) > Date.now())
        return saved.url;
    }
    const result = await api<InvitationLink>(
      '/team-invitations',
      'POST',
      user.role === 'admin' ? { supervisorId } : {},
    );
    if (
      !/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=invite_[A-Za-z0-9_-]{43}$/.test(result.url) ||
      !(Date.parse(result.expiresAt) > Date.now())
    )
      throw new Error('Ссылка Telegram недоступна. Попробуйте позже.');
    invites.current.set(supervisorId, result);
    return result.url;
  }

  return (
    <>
      <div className="pico-home-actions" role="group" aria-label="Дополнительные действия">
        <div className="pico-home-actions-track" ref={carousel}>
          <ActionCard
            icon="star"
            tone="support"
            title="Поддержать"
            description="Звёзды ускорят новые функции"
            onClick={onSupport}
          />
          <ActionCard
            icon="user-plus"
            tone="share"
            title={shareTitle}
            description={shareDescription}
            onClick={() => setShareOpen(true)}
          />
          <ActionCard
            icon="bulb"
            tone="idea"
            title="Идея"
            description="Как сделать вашу работу проще?"
            onClick={onIdea}
          />
        </div>
        {pagination.count > 1 && (
          <div className="pico-home-action-dots">
            {Array.from({ length: pagination.count }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`Показать действия, страница ${index + 1}`}
                aria-current={index === pagination.selected ? 'true' : undefined}
                onClick={() => {
                  carousel.current?.scrollTo({ left: index * cardStep });
                }}
              />
            ))}
          </div>
        )}
      </div>
      {shareOpen && (
        <ShareSheet
          user={user}
          users={users}
          message={message}
          onMessage={(value) => {
            setMessage(value);
            try {
              localStorage.setItem(draftKey, value);
            } catch {}
          }}
          getLink={getLink}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  );
}

function ActionCard({
  description,
  icon,
  onClick,
  title,
  tone,
}: {
  description: string;
  icon: string;
  onClick: () => void;
  title: string;
  tone: string;
}) {
  return (
    <button type="button" className="pico-home-action" onClick={onClick}>
      <span className={`pico-home-action-icon is-${tone}`}>
        <Icon name={icon} size={20} />
      </span>
      <strong>{title}</strong>
      <span className="pico-home-action-description">{description}</span>
    </button>
  );
}

function ShareSheet({
  user,
  users,
  message,
  onMessage,
  getLink,
  onClose,
}: {
  user: Actor;
  users: Actor[];
  message: string;
  onMessage: (message: string) => void;
  getLink: (supervisorId: string) => Promise<string>;
  onClose: () => void;
}) {
  const [supervisorId, setSupervisorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const supervisors = users.filter((person) => person.active && person.role === 'supervisor');
  const isAdmin = user.role === 'admin';
  const hasTeam = !isAdmin || supervisors.some((person) => person.id === supervisorId);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function share(method: 'copy' | 'send') {
    if (operation.current || !hasTeam) return;
    operation.current = true;
    setBusy(true);
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    setError('');
    const text = message.trim();
    const telegram = window.Telegram?.WebApp;
    const openTelegram =
      telegram?.initData &&
      'openTelegramLink' in telegram &&
      typeof telegram.openTelegramLink === 'function'
        ? telegram.openTelegramLink.bind(telegram)
        : undefined;
    let popup: Window | null = null;
    try {
      if (method === 'send' && !openTelegram) {
        popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
      }
      const link = getLink(supervisorId);
      if (method === 'copy') {
        const clipboardText = link.then((url) => (text ? `${text}\n\n${url}` : url));
        await copyMessage(clipboardText);
        setCopied(true);
        copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
      } else {
        const url = new URL('https://t.me/share/url');
        url.searchParams.set('url', await link);
        if (text) url.searchParams.set('text', text);
        if (openTelegram) openTelegram(url.href);
        else if (popup && !popup.closed) popup.location.replace(url.href);
        else window.location.assign(url.href);
      }
    } catch (e) {
      popup?.close();
      setError(
        e instanceof Error && e.message
          ? e.message
          : 'Не удалось подготовить ссылку. Попробуйте ещё раз.',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title={shareTitle}
      titleIcon={
        <span className="pico-home-action-icon is-share">
          <Icon name="user-plus" size={20} />
        </span>
      }
      sheet
      closeDisabled={busy}
      onClose={() => {
        if (!operation.current) onClose();
      }}
    >
      <div className="pico-share-sheet">
        <p className="pico-share-intro">{shareDescription}</p>
        {isAdmin && (
          <Field label="Команда руководителя">
            <select
              value={supervisorId}
              onChange={(event) => setSupervisorId(event.target.value)}
              disabled={busy || !supervisors.length}
            >
              <option value="">
                {supervisors.length ? 'Выберите руководителя' : 'Нет активных руководителей'}
              </option>
              {supervisors.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="pico-share-preview">
          <label htmlFor="pico-share-message">Коллега получит</label>
          <textarea
            id="pico-share-message"
            aria-describedby="pico-share-hint"
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            rows={3}
          />
          <div className="pico-share-bot">
            <img src={picoAvatar} alt="" width="32" height="32" />
            <span>
              <strong>Pico Bot</strong>
              <small>Клиенты и задачи в Telegram</small>
            </span>
          </div>
        </div>
        <p className="pico-share-hint" id="pico-share-hint">
          Нажмите на текст, чтобы изменить
        </p>
        <p className="pico-share-scope">
          {user.role === 'manager'
            ? 'Коллега получит ссылку на бота. Доступ к CRM выдаёт руководитель.'
            : 'Ссылка действует 24 часа и открывает доступ одному новому сотруднику. Передайте её лично.'}
        </p>
        <button
          type="button"
          className="pico-share-copy"
          data-copied={copied || undefined}
          disabled={!hasTeam}
          aria-disabled={busy || undefined}
          onClick={() => void share('copy')}
        >
          <Icon name={copied ? 'check' : 'copy'} size={18} />
          {copied ? 'Сообщение скопировано' : 'Скопировать сообщение'}
        </button>
        <button
          type="button"
          className="primary pico-share-send"
          disabled={!hasTeam}
          aria-disabled={busy || undefined}
          onClick={() => void share('send')}
        >
          <Icon name="send" size={18} />
          Отправить коллеге
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <span className="pico-share-announcement" role="status">
          {busy ? 'Готовим ссылку…' : copied ? 'Сообщение скопировано' : ''}
        </span>
      </div>
    </Modal>
  );
}

async function copyMessage(text: Promise<string>) {
  // ClipboardItem keeps the gesture active while the first link is requested in Safari.
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const content = text.then((value) => new Blob([value], { type: 'text/plain' }));
    // The clipboard API may reject before reading the promised content.
    void content.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]);
      return;
    } catch {}
  }
  const value = await text;
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {}
  const focused = document.activeElement;
  const copyField = document.createElement('textarea');
  copyField.className = 'pico-share-announcement';
  copyField.value = value;
  copyField.tabIndex = -1;
  copyField.readOnly = true;
  (focused?.closest('[data-pico-modal]') ?? document.body).append(copyField);
  try {
    copyField.focus({ preventScroll: true });
    copyField.select();
    if (document.execCommand('copy')) return;
  } catch {
    // Clipboard policy may reject the legacy API too.
  } finally {
    copyField.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  throw new Error('Не удалось скопировать ссылку. Используйте «Отправить коллеге».');
}
