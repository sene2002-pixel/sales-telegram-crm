import { useEffect, useId, useRef, useState } from 'react';
import {
  PicoStarInvoice,
  PicoStarInvoiceStatus,
  picoStarsMaximum,
  picoStarsMinimum,
} from '../shared/pico-stars';
import { api, ApiError } from './api';
import { Modal } from './forms';
import { Icon } from './Icons';
import { appendPicoNumberKey, PicoNumberKeys } from './PicoNumberInput';
import './home-support.css';

const presets = [50, 100, 250, 500];
const defaultAmount = 100;
const invoicePath = '/me/pico-stars/invoices';
const integerFormat = new Intl.NumberFormat('ru-RU');
const plural = new Intl.PluralRules('ru-RU');

type InvoiceResult = 'paid' | 'pending' | 'cancelled' | 'failed';
type InvoiceWebApp = NonNullable<NonNullable<Window['Telegram']>['WebApp']> & {
  openInvoice?: (url: string, callback: (status: InvoiceResult) => void) => void;
};

function starsLabel(amount: number, singular = 'звезда') {
  const category = plural.select(amount);
  const word = category === 'one' ? singular : category === 'few' ? 'звезды' : 'звёзд';
  return `${integerFormat.format(amount)} ${word}`;
}

export function HomeSupport({ actorId, onClose }: { actorId: string; onClose: () => void }) {
  const pendingKey = `pico-stars-pending-invoice:${actorId}`;
  const [preset, setPreset] = useState(defaultAmount);
  const [custom, setCustom] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [pendingId, setPendingId] = useState(() => sessionStorage.getItem(pendingKey));
  const [checking, setChecking] = useState(Boolean(pendingId));
  const [retry, setRetry] = useState(0);
  const [paid, setPaid] = useState<number | null>(null);
  const [error, setError] = useState('');
  const activeInvoice = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const customButton = useRef<HTMLButtonElement>(null);
  const hasEdited = useRef(false);
  const customHintId = useId();
  const amount = custom ?? preset;
  const validDraft =
    draft.length > 0 && Number(draft) >= picoStarsMinimum && Number(draft) <= picoStarsMaximum;
  const selectionLocked = opening || Boolean(pendingId);

  useEffect(() => {
    if (editing) input.current?.focus({ preventScroll: true });
    else if (hasEdited.current) customButton.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    setChecking(true);
    async function check() {
      try {
        const result = await api<PicoStarInvoiceStatus>(`${invoicePath}/${pendingId}`);
        if (cancelled) return;
        if (result.status !== 'pending') {
          sessionStorage.removeItem(pendingKey);
          setPendingId(null);
          setChecking(false);
          if (result.status === 'paid') setPaid(result.amount);
          else if (result.status === 'refunded') setError('Звёзды возвращены.');
          else setError('Срок счёта истёк. Если звёзды списались, напишите боту /paysupport.');
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 404) {
          sessionStorage.removeItem(pendingKey);
          setPendingId(null);
          setChecking(false);
          setError('Счёт не найден. Проверьте историю платежей в Telegram.');
          return;
        }
      }
      attempts++;
      if (attempts < 7) timer = window.setTimeout(check, attempts < 3 ? 500 : 2_000);
      else setChecking(false);
    }
    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pendingId, pendingKey, retry]);

  function close() {
    if (activeInvoice.current) return;
    if (editing) setEditing(false);
    else onClose();
  }

  async function pay() {
    if (activeInvoice.current || pendingId) return;
    const telegram = window.Telegram?.WebApp as InvoiceWebApp | undefined;
    setError('');
    if (!telegram?.initData) {
      setError('Откройте Pico в Telegram, чтобы отправить звёзды.');
      return;
    }
    if (!telegram.openInvoice || telegram.isVersionAtLeast?.('6.1') === false) {
      setError('Обновите Telegram, чтобы отправить звёзды.');
      return;
    }
    activeInvoice.current = true;
    setOpening(true);
    try {
      const invoice = await api<PicoStarInvoice>(invoicePath, 'POST', { amount });
      telegram.openInvoice(invoice.url, (status) => {
        activeInvoice.current = false;
        setOpening(false);
        if (status === 'paid' || status === 'pending') {
          sessionStorage.setItem(pendingKey, invoice.id);
          setPendingId(invoice.id);
          setChecking(true);
        } else if (status === 'failed') {
          setError('Telegram не смог провести оплату. Попробуйте ещё раз.');
        }
      });
    } catch (cause) {
      activeInvoice.current = false;
      setOpening(false);
      setError(
        cause instanceof ApiError && (cause.status === 429 || cause.status === 503)
          ? cause.message
          : 'Не удалось открыть счёт. Попробуйте ещё раз.',
      );
    }
  }

  function applyCustom() {
    if (!validDraft) return;
    setCustom(Number(draft));
    setEditing(false);
  }

  return (
    <Modal
      title={paid === null ? 'Поддержать' : 'Спасибо!'}
      className="pico-support-modal"
      onClose={close}
      sheet
      hideHeader
      showHandle={false}
    >
      <div className="pico-support">
        {!editing && (
          <button
            type="button"
            className="icon pico-support-close"
            disabled={opening}
            onClick={close}
            aria-label="Закрыть"
          >
            <Icon name="close" />
          </button>
        )}
        {editing ? (
          <form
            className="pico-support-custom-editor"
            onSubmit={(event) => {
              event.preventDefault();
              applyCustom();
            }}
          >
            <label>
              <span>Количество звёзд</span>
              <span className="pico-support-input-row">
                <Icon name="star" size={24} />
                <input
                  ref={input}
                  inputMode="none"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={draft}
                  placeholder="0"
                  aria-invalid={draft !== '' && !validDraft}
                  aria-describedby={customHintId}
                  onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 5))}
                />
              </span>
            </label>
            <p id={customHintId} className="pico-support-hint">
              От 1 до 10 000 звёзд
            </p>
            <PicoNumberKeys
              integerOnly
              onKey={(value) =>
                setDraft((current) => appendPicoNumberKey(current, value).slice(0, 5))
              }
            />
            <button type="submit" className="pico-number-done" disabled={!validDraft}>
              Готово
            </button>
            <button type="button" className="pico-support-cancel" onClick={close}>
              Отмена
            </button>
          </form>
        ) : (
          <>
            <header className="pico-support-hero">
              <div className="pico-support-emblem">
                <Icon name="star" size={48} />
              </div>
              <h2>{paid === null ? 'Поддержать' : 'Спасибо!'}</h2>
              <p>
                {paid === null
                  ? 'Звёзды ускорят новые функции. Каждая звезда идёт на развитие.'
                  : `Вы отправили ${starsLabel(paid, 'звезду')}. Они пойдут на новые функции.`}
              </p>
            </header>
            {paid === null ? (
              <>
                <fieldset className="pico-support-amounts" disabled={selectionLocked}>
                  <legend>Сколько звёзд</legend>
                  <div className="pico-support-grid">
                    {presets.map((value) => {
                      const selected = custom === null && preset === value;
                      return (
                        <button
                          type="button"
                          key={value}
                          aria-label={starsLabel(value)}
                          aria-pressed={selected}
                          className="pico-support-preset"
                          onClick={() => {
                            setPreset(value);
                            setCustom(null);
                            setError('');
                          }}
                        >
                          <Icon name="star" size={24} />
                          <span className="pico-support-quantity">
                            {value}
                            {value === defaultAmount && <small>Чаще выбирают</small>}
                          </span>
                          {selected && <Icon name="check" size={16} />}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    ref={customButton}
                    type="button"
                    className="pico-support-custom"
                    aria-pressed={custom !== null}
                    onClick={() => {
                      hasEdited.current = true;
                      setDraft(custom === null ? '' : String(custom));
                      setError('');
                      setEditing(true);
                    }}
                  >
                    {custom === null ? 'Другое количество' : starsLabel(custom)}
                    <Icon name={custom === null ? 'chevron-right' : 'check'} size={16} />
                  </button>
                </fieldset>
                {error && (
                  <p className="pico-support-error" role="alert">
                    {error}
                  </p>
                )}
                {pendingId ? (
                  <>
                    <p className="pico-support-status" role="status">
                      {checking
                        ? 'Проверяем оплату в Telegram…'
                        : 'Оплата ещё обрабатывается. Если звёзды списались, напишите боту /paysupport.'}
                    </p>
                    <button
                      type="button"
                      className="pico-support-pay"
                      disabled={checking}
                      onClick={() => {
                        setChecking(true);
                        setRetry((value) => value + 1);
                      }}
                    >
                      Проверить оплату
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="pico-support-pay"
                    disabled={opening}
                    onClick={pay}
                  >
                    {opening ? 'Открываем счёт…' : `Поддержать · ${integerFormat.format(amount)}`}
                  </button>
                )}
                <p className="pico-support-hint">Оплата в Telegram, без карты</p>
              </>
            ) : (
              <button type="button" className="pico-support-pay" onClick={onClose}>
                На главную
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
