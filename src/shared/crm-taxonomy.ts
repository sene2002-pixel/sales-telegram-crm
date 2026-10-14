// Stable legacy keys stay valid; unspecified legacy drives are never assigned a voltage.
export const segments = [
  'shchitovik',
  'oem',
  'end_client',
  'contractor',
  'design_institute',
  'general_contractor',
  'grid_company',
  'commercial',
  'integrator',
  'unknown',
] as const;
export const primarySegments = [
  'end_client',
  'contractor',
  'general_contractor',
  'grid_company',
  'design_institute',
  'integrator',
  'commercial',
  'oem',
] as const;
export const divisions = [
  'lv',
  'mv',
  'drives',
  'drives_lv',
  'drives_mv',
  'cells',
  'heat',
  'services',
] as const;
export const primaryDivisions = [
  'lv',
  'mv',
  'drives_lv',
  'drives_mv',
  'cells',
  'heat',
  'services',
] as const;
export const projectSupplyTypes = ['automation', 'switchboard', 'generator', 'other'] as const;
export const projectServiceTypes = ['supervision', 'commissioning', 'maintenance'] as const;
export const equipmentKeys = [...divisions, ...projectSupplyTypes, ...projectServiceTypes] as const;
export const divisionLabels: Record<string, string> = {
  lv: 'Выключатели 0,4 кВ',
  mv: 'Выключатели 6–35 кВ',
  drives: 'ПЧ / УПП · напряжение не указано',
  drives_lv: 'ПЧ и УПП 0,4 кВ',
  drives_mv: 'ПЧ и УПП 6–35 кВ',
  cells: 'Ячейки КРУ (КСО)',
  heat: 'Теплотехника',
  services: 'Услуги',
  automation: 'АСУ ТП',
  switchboard: 'НКУ',
  generator: 'ДГУ (ДЭС)',
  other: 'Другое',
  supervision: 'Шеф-монтаж',
  commissioning: 'ПНР',
  maintenance: 'Сервисное обслуживание',
};
export const segmentLabels: Record<string, string> = {
  unknown: 'Тип не указан',
  shchitovik: 'Щитовик',
  oem: 'OEM',
  end_client: 'Заказчик',
  contractor: 'Подрядчик',
  design_institute: 'Проектный институт',
  general_contractor: 'Генподрядчик',
  grid_company: 'Сетевая компания',
  commercial: 'Коммерческая организация',
  integrator: 'Интегратор',
};
