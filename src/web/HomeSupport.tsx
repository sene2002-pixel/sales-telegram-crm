import { useEffect, useId, useRef, useState } from 'react';
import {
  PicoStarInvoice,
  PicoStarInvoiceStatus,
  PicoStarInvoiceOverview,
  PicoStarReceipt,
  picoStarsMaximum,
  picoStarsMinimum,
} from '../shared/pico-stars';
import { idSchema } from '../shared/contracts';
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
  return (
    <SupportPanel
      key={actorId}
      pendingKey={`pico-stars-pending-invoice:${actorId}`}
      onClose={onClose}
    />
  );
}

function SupportPanel({ pendingKey, onClose }: { pendingKey: string; onClose: () => void }) {
  const [overview, setOverview] = useState<PicoStarInvoiceOverview | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [status, setStatus] = useState<PicoStarInvoiceStatus | null>(null);
  const [receipt, setReceipt] = useState<PicoStarReceipt | null>(null);
  const [previousOutcome, setPreviousOutcome] = useState<{ id: string; text: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState(defaultAmount);
  const [custom, setCustom] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const mounted = useRef(false);
  const currentId = useRef<string | null>(null);
  const creating = useRef(false);
  const storedInvoiceToReconcile = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const customButton = useRef<HTMLButtonElement>(null);
  const successButton = useRef<HTMLButtonElement>(null);
  const hasEdited = useRef(false);
  const customHintId = useId();
  const consentId = useId();
  const amount = custom ?? preset;
  const validDraft =
    /^\d+$/.test(draft) && Number(draft) >= picoStarsMinimum && Number(draft) <= picoStarsMaximum;
  const termsUrl =
    overview?.enabled && overview.termsUrl && /^https:\/\//i.test(overview.termsUrl)
      ? overview.termsUrl
      : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentId.current = null;
    };
  }, []);

  function selectInvoice(id: string | null) {
    currentId.current = id;
    setPendingId(id);
    setStatus(null);
    setStatusUnavailable(false);
    setCancelling(false);
  }

  function clearStored(id: string) {
    try {
      for (const storage of [localStorage, sessionStorage]) {
        if (storage.getItem(pendingKey) === id) storage.removeItem(pendingKey);
      }
    } catch {
      // The server keeps both outstanding invoices and settled receipts.
    }
  }

  useEffect(() => {
    let active = true;
    api<PicoStarInvoiceOverview>(`${invoicePath}/active`)
      .then((result) => {
        if (!active) return;
        let id = result.id;
        storedInvoiceToReconcile.current = null;
        if (!id && recoveryAttempt === 0) {
          try {
            const saved = localStorage.getItem(pendingKey) ?? sessionStorage.getItem(pendingKey);
            if (saved && !idSchema.safeParse(saved).success) clearStored(saved);
            else if (saved && saved !== result.lastPayment?.id) {
              id = saved;
              if (result.lastPayment) storedInvoiceToReconcile.current = saved;
            }
          } catch {
            /* Browser storage is optional for server recovery. */
          }
        }
        selectInvoice(id);
        setReceipt(id ? null : result.lastPayment);
        if (id || result.lastPayment) setError('');
        if (!id && result.lastPayment) clearStored(result.lastPayment.id);
        setOverview(result);
      })
      .catch(() => {
        if (active)
          setError('Не удалось проверить предыдущий счёт. Проверьте соединение и повторите.');
      });
    return () => {
      active = false;
    };
  }, [recoveryAttempt, pendingKey]);

  function reloadOverview() {
    setOverview(null);
    setError('');
    setAccepted(false);
    setRecoveryAttempt((value) => value + 1);
  }

  useEffect(() => {
    if (editing) input.current?.focus({ preventScroll: true });
    else if (hasEdited.current) customButton.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    if (receipt) successButton.current?.focus({ preventScroll: true });
  }, [receipt]);

  useEffect(() => {
    if (!pendingId) return;
    const id = pendingId;
    let active = true;
    let timer: number | undefined;
    let attempts = 0;
    const isCurrent = () => active && currentId.current === id;
    async function check() {
      setChecking(true);
      try {
        const result = await api<PicoStarInvoiceStatus>(`${invoicePath}/${id}`);
        if (!isCurrent()) return;
        setStatusUnavailable(false);
        if (result.status === 'pending') {
          setStatus(result);
        } else {
          clearStored(id);
          selectInvoice(null);
          setChecking(false);
          setAccepted(false);
          if (result.status === 'expired' || storedInvoiceToReconcile.current === id) {
            // A previously stored attempt and the last confirmed payment can be different.
            // Re-read the overview: settlement may also have happened between the two reads.
            const amount = starsLabel(result.amount, 'звезду');
            const text =
              result.status === 'paid'
                ? `Сохранённый счёт на ${amount} оплачен.`
                : result.status === 'refunded'
                  ? `По сохранённому счёту на ${amount} оформлен возврат.`
                  : `Счёт на ${amount} закрыт без подтверждённой оплаты.`;
            setPreviousOutcome({ id, text });
            reloadOverview();
          } else {
            setError('');
            setReceipt({ id, amount: result.amount, status: result.status });
          }
          return;
        }
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof ApiError && cause.status === 404) {
          clearStored(id);
          selectInvoice(null);
          setChecking(false);
          setPreviousOutcome({
            id,
            text: 'Сохранённый счёт не найден. Проверьте историю платежей в Telegram.',
          });
          reloadOverview();
          return;
        }
        setStatusUnavailable(true);
      }
      setChecking(false);
      attempts++;
      if (attempts < 7) timer = window.setTimeout(check, attempts < 3 ? 500 : 2_000);
    }
    void check();
    const resume = () => {
      if (document.visibilityState === 'visible' && isCurrent()) setRetry((value) => value + 1);
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [pendingId, pendingKey, retry]);

  async function cancelInvoice(id: string, fromFailure = false) {
    if (currentId.current !== id) return;
    setCancelling(true);
    try {
      const result = await api<{ cancelled: boolean }>(`${invoicePath}/${id}/cancel`, 'POST');
      if (currentId.current !== id) return;
      if (result.cancelled) {
        clearStored(id);
        selectInvoice(null);
        reloadOverview();
        setError(fromFailure ? 'Telegram не смог провести оплату. Попробуйте ещё раз.' : '');
      } else {
        setStatus(null);
        setError('Оплата уже началась. Проверьте её статус.');
        setRetry((value) => value + 1);
      }
    } catch {
      if (currentId.current === id)
        setError('Не удалось проверить отмену. Проверьте статус счёта.');
    } finally {
      if (currentId.current === id) setCancelling(false);
    }
  }

  function close() {
    if (editing) setEditing(false);
    else onClose();
  }

  async function pay() {
    if (creating.current || currentId.current || receipt || !accepted || !termsUrl) return;
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
    setPreviousOutcome(null);
    creating.current = true;
    setOpening(true);
    try {
      const invoice = await api<PicoStarInvoice>(invoicePath, 'POST', {
        amount,
        acceptedTermsUrl: termsUrl,
      });
      if (!mounted.current) return;
      selectInvoice(invoice.id);
      try {
        localStorage.setItem(pendingKey, invoice.id);
      } catch {
        // The server can restore the open invoice and its eventual receipt across devices.
      }
      telegram.openInvoice(invoice.url, (result) => {
        if (currentId.current !== invoice.id) return;
        if (result === 'cancelled' || result === 'failed') {
          void cancelInvoice(invoice.id, result === 'failed');
        } else {
          setRetry((value) => value + 1);
        }
      });
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 429) setError(cause.message);
      else if (currentId.current)
        setError('Не удалось открыть окно Telegram. Проверьте состояние счёта.');
      else {
        // The POST may have succeeded even if the response never reached this device.
        reloadOverview();
        if (cause instanceof ApiError && cause.status === 412)
          setError('Условия изменились. Ознакомьтесь с ними ещё раз.');
        else if (!(cause instanceof ApiError && [409, 503].includes(cause.status)))
          setError('Не удалось открыть окно оплаты. Проверьте соединение и повторите.');
      }
    } finally {
      creating.current = false;
      if (mounted.current) setOpening(false);
    }
  }

  function applyCustom() {
    if (!validDraft) return;
    setCustom(Number(draft));
    setEditing(false);
  }

  const recoveredReceipt = receipt && receipt.id === overview?.lastPayment?.id;
  let title = pendingId ? 'Статус оплаты' : 'Поддержать';
  if (receipt?.status === 'paid') title = recoveredReceipt ? 'Последняя оплата' : 'Спасибо!';
  if (receipt?.status === 'refunded')
    title = recoveredReceipt ? 'Последний возврат' : 'Возврат звёзд';
  const canChoose = Boolean(termsUrl && !pendingId && !receipt);
  return (
    <Modal
      title={title}
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
                  onChange={(event) => setDraft(event.target.value)}
                />
              </span>
            </label>
            <p id={customHintId} className="pico-support-hint">
              {draft && !validDraft
                ? 'Введите целое число от 1 до 10 000.'
                : 'От 1 до 10 000 звёзд'}
            </p>
            <PicoNumberKeys
              integerOnly
              onKey={(value) => setDraft((current) => appendPicoNumberKey(current, value))}
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
              <h2>{title}</h2>
              {receipt ? (
                <p>
                  {receipt.status === 'paid'
                    ? `Вы отправили ${starsLabel(receipt.amount, 'звезду')} на развитие Pico.`
                    : `Сумма возврата — ${starsLabel(receipt.amount)}.`}
                </p>
              ) : pendingId ? (
                <p role="status">
                  {status && `Счёт на ${starsLabel(status.amount, 'звезду')}. `}
                  {statusUnavailable
                    ? 'Не удалось получить статус. Проверьте соединение и повторите.'
                    : status
                      ? 'Ожидаем подтверждение Telegram.'
                      : 'Проверяем счёт в Telegram…'}
                </p>
              ) : canChoose ? (
                <p>Ваша поддержка поможет развивать Pico.</p>
              ) : overview || !error ? (
                <p role="status">
                  {overview ? 'Приём звёзд сейчас недоступен.' : 'Проверяем предыдущий счёт…'}
                </p>
              ) : null}
            </header>
            {overview && !pendingId && previousOutcome && previousOutcome.id !== receipt?.id && (
              <p className="pico-support-status" role="status">
                {previousOutcome.text}
              </p>
            )}
            {error && (
              <p role="alert" className="pico-support-error">
                {error}
              </p>
            )}
            {canChoose && termsUrl && (
              <>
                <fieldset className="pico-support-amounts" disabled={opening}>
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
                            {value === defaultAmount && <small>Рекомендуем</small>}
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
                <div className="pico-support-consent">
                  <input
                    id={consentId}
                    type="checkbox"
                    checked={accepted}
                    disabled={opening}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />
                  <div>
                    <label htmlFor={consentId}>Я принимаю условия поддержки Pico.</label>{' '}
                    <a href={termsUrl} target="_blank" rel="noopener noreferrer">
                      Прочитать условия
                    </a>
                  </div>
                </div>
                <button
                  type="button"
                  className="pico-support-pay"
                  disabled={opening || !accepted}
                  onClick={pay}
                >
                  {opening ? 'Открываем счёт…' : `Поддержать · ${starsLabel(amount)}`}
                </button>
                <p className="pico-support-hint">Оплата звёздами в Telegram</p>
              </>
            )}
            {!overview && error && (
              <button type="button" className="pico-support-pay" onClick={reloadOverview}>
                Проверить предыдущий счёт
              </button>
            )}
            {pendingId && (
              <>
                <button
                  type="button"
                  className="pico-support-pay"
                  aria-busy={checking}
                  disabled={cancelling}
                  onClick={() => {
                    setError('');
                    setRetry((value) => value + 1);
                  }}
                >
                  Проверить оплату
                </button>
                {status?.canCancel && !statusUnavailable && (
                  <button
                    type="button"
                    className="pico-support-cancel"
                    disabled={cancelling}
                    onClick={() => void cancelInvoice(pendingId)}
                  >
                    Отменить счёт
                  </button>
                )}
                <p className="pico-support-hint">
                  Если статус долго не меняется, напишите боту /paysupport. Можно обратиться без
                  чека.
                </p>
              </>
            )}
            {receipt && (
              <>
                <button
                  ref={successButton}
                  type="button"
                  className="pico-support-pay"
                  onClick={onClose}
                >
                  На главную
                </button>
                {termsUrl && (
                  <button
                    type="button"
                    className="pico-support-cancel"
                    onClick={() => {
                      setPreviousOutcome(null);
                      setReceipt(null);
                      setAccepted(false);
                    }}
                  >
                    Поддержать ещё раз
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
