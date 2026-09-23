import { looksLikeContactCommand } from './contact-intent';

export const unknownCommand = 'Не знаю такой команды. Примеры — /voice.';

// Apply only after supported commands. Historical meeting notes remain reports.
export function looksLikeCommand(text: string) {
  const value = text.trim();
  return (
    looksLikeContactCommand(value) ||
    value.startsWith('/') ||
    !/[\p{L}\p{N}]/u.test(value) ||
    // These signature operations also allow polite prefixes and infinitives.
    // Run this fallback after signature routing so unsupported variants never become reports.
    /^(?:пожалуйста[\s,.:;!?—–-]+)?(?:(?:нужно|надо|хочу|можешь|можете)[\s,.:;!?—–-]+)?(?:пожалуйста[\s,.:;!?—–-]+)?(?:измен(?:и(?:те)?|ить)|(?:от)?редактир(?:уй(?:те)?|овать)|поменя(?:й(?:те)?|ть)|обнов(?:и(?:те)?|ить)|исправ(?:ь(?:те)?|ить)|удал(?:и(?:те)?|ить)|уб(?:ери(?:те)?|рать))(?=$|[\s,.:;!?—–-])/iu.test(
      value,
    ) ||
    /^(?:пожалуйста[,\s]+)?(?:отправь(?:те)?|подготовь(?:те)?|напиши(?:те)?|создай(?:те)?|составь(?:те)?|сформируй(?:те)?|сгенерируй(?:те)?|добавь(?:те)?|сохрани(?:те)?|запиши(?:те)?|сделай(?:те)?|измени(?:те)?|поменяй(?:те)?|исправь(?:те)?|обнови(?:те)?|отредактируй(?:те)?|назначь(?:те)?|выбери(?:те)?|установи(?:те)?|задай(?:те)?|удали(?:те)?|покажи(?:те)?|открой(?:те)?|отмени(?:те)?)(?:\s|[.,:!?]|$)/iu.test(
      value,
    )
  );
}
