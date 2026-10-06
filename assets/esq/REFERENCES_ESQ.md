# База референсов ESQ / ЭЛКОМ (факты поставок)

Источник: референс-листы ЭЛКОМ — каталог «Референции ESQ в промышленности» (май 2026), РУВН 6–35 кВ 2022–2025, АСУ ТП и щитовое оборудование 2022–2025, частотные преобразователи и УПП, ESQ в ЦОД.

## Действующие правила

Отрасль и основной вид деятельности именно адресуемого юрлица определяются по сайту/ОКВЭД и подтверждаются менеджером до генерации. Не определять отрасль по названию, региону или размеру. Таблица основных и разрешённых смежных групп закреплена в `src/shared/reference-industries.ts`.

Код выбирает только индивидуальные записи `reference` ниже, с `allowed: true`. Архив первоисточника в конце не передаётся модели и не является действующей инструкцией отбора.

1. Сначала основная группа. Только если в ней менее двух подходящих объектов, допускается не более одного смежного.
2. Внутри группы: точное совпадение деятельности/оборудования → ★ → регион → известность. Для равноподходящих вариантов избегать набора предыдущего письма.
3. 2–3 объекта; если доступен только один — использовать его. Если ни одного — нейтральная фраза и уведомление менеджеру о ручном подборе.
4. Только факты состоявшихся поставок. Не добавлять оборудование, объёмы или названия вне записи. ИБП, HYUNDAI и будущие проекты запрещены.
5. Объекты оборонного/военного сектора имеют `allowed: false` до явного разрешения на упоминание. Записи «Также» без конкретного оборудования также отключены до проверки источника.
6. Целевая длина 330–420 знаков. По согласованию от 07.10.2026 при недостатке фактов короткий блок разрешён и для 2–3 объектов; один объект и нейтральная фраза также могут быть короче. Максимум — 420. Не дополнять выдуманными фактами или искусственным текстом. Начало: «Продукция ESQ уже применяется на объектах …». Собственное производство/ЗИП добавляются шаблоном, не референсами.
7. При сокращении убрать сначала смежный объект, затем последний основной. Первый основной сохранить.
8. Новые записи: уникальный стабильный ID, группа, одно предприятие/объект, дословные факты, профиль, регион, ★ и явное разрешение. Числа из общей строки нельзя приписывать отдельному предприятию без подтверждения.

★ — отметка сильного кейса из исходной базы. Сокращения: ВЛК — выключатели в литом корпусе; ВВ — вакуумные выключатели; ЭВН — элегазовые выключатели нагрузки; ПЧ — частотные преобразователи; УПП — устройства плавного пуска; БМЗ — блочно-модульное здание.

## Наполнение групп

Количество ниже учитывает разрешённые записи. Группы с менее чем двумя объектами требуют пополнения; один объект остаётся допустимым, ноль ведёт к смежной группе либо нейтральной фразе.

| ID | Группа | Разрешено объектов |
|---|---|---:|
| oil-gas | Нефтегаз | 13 |
| chemical | Химия | 11 |
| mining | Горнодобыча | 25 |
| metallurgy | Металлургия | 17 |
| power-generation | Энергетика — генерация | 3 |
| power-grids | Энергетика — сети | 13 |
| data-telecom | ЦОД/телеком | 9 |
| utilities | ЖКХ | 12 |
| food | Пищевая/АПК | 11 |
| construction | Строительство | 6 |
| commercial | Коммерческая недвижимость | 1 |
| residential | Жилая недвижимость | 4 |
| materials | Стройматериалы | 9 |
| oem | Машиностроение/OEM | 20 |
| switchboards | Щитовое производство | 6 |
| defense | Оборонный и военный сектор | 0 |
| public | Госсектор | 2 |

Коммерческая недвижимость: только один подтверждённый объект (ТЦ «Остров»). Оборонный сектор: разрешённых объектов нет, требуется разрешение на упоминание; допустимые смежные референсы выбираются по общей таблице.

## Индивидуальные записи

```reference
{"id":"esq-001","group":"oil-gas","name":"ООО «Новатэк-Таркосаленефтегаз»","facts":"распредустройства ESQ, БМЗ ЗРУ с ЧРП для БКНС (БМЗ.ESQ), ПЧ 6 кВ ESQ, ВЛК, воздушные и вакуумные выключатели.","profile":"ЯНАО, группа НОВАТЭК","region":"ЯНАО","star":true,"allowed":true}
```

```reference
{"id":"esq-002","group":"oil-gas","name":"ООО «Газпромнефть-Заполярье»","facts":"высоковольтные ПЧ ESQ, модульное оборудование, ВЛК, воздушные и вакуумные выключатели.","profile":"группа «Газпром нефть»","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-003","group":"oil-gas","name":"ООО «НКНП» (Нефтяная компания «Новый поток»)","facts":"4 подстанции на ESQ: 2КТП-2500-6/0,4 «АБК», 2КТП-2000 «Насосная», 2КТП-1600 «Технология», 2КТП-2000 «Скважины».","profile":"Оренбургская обл., Бузулук","region":"Оренбургская обл., Бузулук","star":true,"allowed":true}
```

```reference
{"id":"esq-004","group":"oil-gas","name":"ПАО «НК «Роснефть»","facts":"вакуумные выключатели и вакуумные контакторы ESQ, ВЛК, воздушные, модульное.","profile":"Самара, ХМАО","region":"Самара, ХМАО","star":false,"allowed":true}
```

```reference
{"id":"esq-005","group":"oil-gas","name":"Шкаповское ГПП (Роснефть)","facts":"ПЧ ESQ.","profile":"Нефтегаз","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-006","group":"oil-gas","name":"ПАО «Газпром»","facts":"воздушные выключатели, низковольтные ПЧ ESQ.","profile":"КС «Хабаровская», магистральный газопровод","region":"КС «Хабаровская», магистральный газопровод","star":false,"allowed":true}
```

```reference
{"id":"esq-007","group":"oil-gas","name":"ООО «Газпромнефть Энергосистемы»","facts":"оборудование РУ-10 кВ (секции 1С-10, 2С-10).","profile":"Нефтегаз","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-008","group":"oil-gas","name":"ООО «ГПН-Развитие»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Тюмень, «Газпром нефть»","region":"Тюмень","star":false,"allowed":true}
```

```reference
{"id":"esq-009","group":"oil-gas","name":"ООО «Лукойл-Западная Сибирь»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Когалым","region":"Когалым","star":false,"allowed":true}
```

```reference
{"id":"esq-010","group":"oil-gas","name":"ПАО «Татнефть»","facts":"вакуумные выключатели и вакуумные контакторы ESQ.","profile":"Альметьевск","region":"Альметьевск","star":false,"allowed":true}
```

```reference
{"id":"esq-011","group":"oil-gas","name":"ООО «Иркутская нефтяная компания»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Нефтегаз","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-012","group":"oil-gas","name":"АО «Березкагаз Югра»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"ХМАО","region":"ХМАО","star":false,"allowed":true}
```

```reference
{"id":"esq-013","group":"chemical","name":"ПАО «СИБУР Холдинг»","facts":"воздушные и вакуумные выключатели ESQ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-014","group":"chemical","name":"ПАО «Нижнекамскнефтехим» (СИБУР)","facts":"ретрофит ESQ 0,4 кВ (2000/630/400 А). ретрофит ESQ 0,4 кВ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-015","group":"oil-gas","name":"ОАО «Новатэк-Арктикгаз»","facts":"система бесперебойного питания.","profile":"Нефтегаз","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-016","group":"oil-gas","name":"ООО «Торглайн»","facts":"КТП-1000-10/0,4, воздушные выключатели, ЭВН ESQ.","profile":"Сахалин, оператор топливоснабжения","region":"Сахалин, оператор топливоснабжения","star":false,"allowed":true}
```

```reference
{"id":"esq-017","group":"mining","name":"ООО «Амур Минералс» (РМК)","facts":"КРУ 10 кВ (13 и 20 ячеек, в БМЗ), КРУ 35 кВ (4 и 11 ячеек), СОПТ, трансформаторы ТСЛ, КРМ 10 кВ, передвижные КТПН, модульное оборудование и выключатели ESQ.","profile":"Хабаровский край, Малмыжское месторождение","region":"Хабаровский край, Малмыжское месторождение","star":true,"allowed":true}
```

```reference
{"id":"esq-018","group":"mining","name":"АО «Тарынская золоторудная компания»","facts":"двухтрансформаторная КТПН 2×1600 кВА с сухими трансформаторами и ячейками КРУ, выключатели ESQ.","profile":"Золотодобыча, добыча золота","region":"Якутия","star":true,"allowed":true}
```

```reference
{"id":"esq-019","group":"mining","name":"ООО «Амур Золото» (Русская платина)","facts":"5 комплектных трансформаторных подстанций (2×1600, 1000, 2×400, 1250 кВА).","profile":"Золотодобыча, добыча золота","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-020","group":"mining","name":"ООО «Восточная горнорудная компания»","facts":"КТП-1000 с ПЧ 250 и 560 кВт в блочно-модульном исполнении, ПЧ ESQ.","profile":"Добыча угля","region":"Сахалин","star":true,"allowed":true}
```

```reference
{"id":"esq-021","group":"mining","name":"АК «АЛРОСА» (ПАО)","facts":"воздушные и вакуумные выключатели, ЭВН, ПЧ ESQ.","profile":"Мирный","region":"Мирный","star":false,"allowed":true}
```

```reference
{"id":"esq-022","group":"mining","name":"АО «Алмазы Анабара»","facts":"РУ-0,4 кВ ESQ в утеплённом БМЗ.","profile":"Добыча алмазов","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-023","group":"mining","name":"АО «Рудник Каральвеем»","facts":"модульное, ВЛК, воздушные, вакуумные выключатели 6-10 кВ.","profile":"Чукотка","region":"Чукотка","star":false,"allowed":true}
```

```reference
{"id":"esq-024","group":"mining","name":"ЗАО «Зангезурский медно-молибденовый комбинат»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Добыча меди и молибдена","region":"Армения","star":false,"allowed":true}
```

```reference
{"id":"esq-025","group":"mining","name":"АО «Далур»","facts":"вакуумные выключатели ESQ.","profile":"Курганская обл., Росатом","region":"Курганская обл.","star":false,"allowed":true}
```

```reference
{"id":"esq-026","group":"mining","name":"ООО «Желтугинская ГРК»","facts":"РТП-6 кВ, передвижные КТП, вакуумные выключатели.","profile":"Забайкалье","region":"Забайкалье","star":false,"allowed":true}
```

```reference
{"id":"esq-027","group":"mining","name":"АО ХК «Якутуголь»","facts":"передвижная подстанция 2КТПНУ, воздушные и вакуумные выключатели.","profile":"Добыча угля","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-028","group":"mining","name":"АО «Михайловский ГОК им. А.В. Варичева»","facts":"подстанция КТПВ, воздушные выключатели, ПЧ. ПЧ/УПП ESQ.","profile":"Металлоинвест","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-029","group":"mining","name":"АО «Русский уголь» (Кузбасская ТК)","facts":"станция запуска и управления насосами в утеплённом БМЗ (Plug and Work ESQ).","profile":"Добыча угля","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-030","group":"mining","name":"ТОО «Актюбинская медная компания»","facts":"модульное оборудование, вакуумные выключатели.","profile":"Добыча меди","region":"Казахстан","star":false,"allowed":true}
```

```reference
{"id":"esq-031","group":"mining","name":"ПАО «Высочайший» (GV Gold)","facts":"шкафы управления ESQ, ПЧ.","profile":"Золотодобыча, добыча золота","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-032","group":"mining","name":"Лебединский ГОК (Металлоинвест)","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-034","group":"mining","name":"Качканарский ГОК (ЕВРАЗ)","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-035","group":"mining","name":"Быстринский ГРК (Норникель)","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-036","group":"mining","name":"Высокогорский ГОК","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-037","group":"mining","name":"Урупский ГОК (УГМК)","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-038","group":"mining","name":"Башмедь","facts":"ПЧ/УПП ESQ.","profile":"Добыча меди","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-039","group":"mining","name":"Мечел «Южный Кузбасс»","facts":"ПЧ/УПП ESQ.","profile":"Добыча угля","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-040","group":"mining","name":"ГДК «Берелех»","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-041","group":"mining","name":"Васильевский рудник","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-042","group":"mining","name":"Прииск Соловьёвский","facts":"ПЧ/УПП ESQ.","profile":"Горнодобыча","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-043","group":"metallurgy","name":"ООО «ЭН+ Торговый дом»","facts":"комплектное оборудование ПС 35/10 кВ, КРУ ESQ на вакуумных выключателях.","profile":"Иркутск, группа En+ / РУСАЛ","region":"Иркутск, группа En+ / РУСАЛ","star":true,"allowed":true}
```

```reference
{"id":"esq-044","group":"metallurgy","name":"ПАО «Магнитогорский металлургический комбинат»","facts":"КТП-2500-10/0,4 кВ, модульное, ВЛК, воздушные и вакуумные выключатели, ПЧ и УПП ESQ.","profile":"Металлургия","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-045","group":"metallurgy","name":"АО «Балаково-Центролит»","facts":"РП РУ-10 кВ на КРУ ESQ, БМЗ 2КТПНУ полной заводской готовности на НКУ ESQ и КСО ESQ, выключатели.","profile":"Металлургия","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-046","group":"metallurgy","name":"ПАО «Челябинский трубопрокатный завод»","facts":"двухтрансформаторная подстанция КТП.ESQ 2×1600/6/0,4, ПЧ.","profile":"Металлургия","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-047","group":"metallurgy","name":"ПАО «Северсталь»","facts":"внутрицеховая подстанция 2КТП-10/0,4 кВ, УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-048","group":"metallurgy","name":"ООО «Эмпилс-Цинк»","facts":"блочно-комплектная 2БКТП 1250/6/0,4 кВ, воздушные и вакуумные выключатели.","profile":"Ростов-на-Дону","region":"Ростов-на-Дону","star":false,"allowed":true}
```

```reference
{"id":"esq-049","group":"metallurgy","name":"ЕВРАЗ НТМК","facts":"УПП ESQ.","profile":"Металлургия","region":"Нижний Тагил","star":false,"allowed":true}
```

```reference
{"id":"esq-050","group":"metallurgy","name":"ЕВРАЗ ЗСМК","facts":"ПЧ ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-051","group":"metallurgy","name":"ЗАО «НТЗ Тэм-по»","facts":"ВЛК, воздушные и вакуумные выключатели.","profile":"Производство труб","region":"трубы, Набережные Челны","star":false,"allowed":true}
```

```reference
{"id":"esq-052","group":"metallurgy","name":"ПАО «Челябинский кузнечно-прессовый завод»","facts":"воздушные выключатели.","profile":"Кузнечно-прессовое производство","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-053","group":"metallurgy","name":"ООО «Алтайский литейный завод»","facts":"вакуумные выключатели.","profile":"Литейное производство","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-054","group":"metallurgy","name":"ОЭМК (Металлоинвест)","facts":"ПЧ/УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-055","group":"metallurgy","name":"Тагмет","facts":"ПЧ/УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-056","group":"metallurgy","name":"ВМЗ (ОМК)","facts":"ПЧ/УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-057","group":"metallurgy","name":"ВСМПО-АВИСМА","facts":"ПЧ/УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-058","group":"metallurgy","name":"НЛМК-Урал","facts":"ПЧ/УПП ESQ.","profile":"Металлургия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-059","group":"metallurgy","name":"Колпинский трубный завод","facts":"ПЧ/УПП ESQ.","profile":"Производство труб","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-060","group":"power-generation","name":"ПАО «ТГК-14»","facts":"РУ-6 кВ на 12 ячейках КСО.ESQ, вакуумные выключатели, ВРУ-0,4 кВ.","profile":"Генерация электроэнергии, ТЭЦ","region":"Чита","star":true,"allowed":true}
```

```reference
{"id":"esq-061","group":"power-generation","name":"МП «ТЭЦ Бишкек»","facts":"РУ-0,4 кВ, 25 ячеек КРУ.ESQ-COMFORT (1600 и 630 А, ТН), выключатели ESQ.","profile":"Генерация электроэнергии, ТЭЦ","region":"Кыргызстан","star":true,"allowed":true}
```

```reference
{"id":"esq-062","group":"power-generation","name":"АО «ТГК-1»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Генерация электроэнергии","region":"Санкт-Петербург","star":false,"allowed":true}
```

```reference
{"id":"esq-063","group":"power-grids","name":"АО «ИЭСК»","facts":"комплектное оборудование подстанций, вакуумные выключатели.","profile":"Иркутск","region":"Иркутск","star":true,"allowed":true}
```

```reference
{"id":"esq-064","group":"power-grids","name":"ООО «Евросибэнерго ТД»","facts":"комплектное оборудование ПС 35/10 кВ «Садоводство», УПП.","profile":"Энергетика — сети","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-065","group":"power-grids","name":"ПАО «Россети Ленэнерго»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-066","group":"power-grids","name":"ПАО «Россети Юг»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-067","group":"power-grids","name":"АО «Донэнерго»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-068","group":"power-grids","name":"ПАО «Магаданэнерго»","facts":"модульное, ВЛК, воздушные выключатели, ЭВН.","profile":"РусГидро","region":"РусГидро","star":false,"allowed":true}
```

```reference
{"id":"esq-069","group":"power-grids","name":"АО «Сетевая компания»","facts":"ВЛК, воздушные выключатели.","profile":"Татарстан","region":"Татарстан","star":false,"allowed":true}
```

```reference
{"id":"esq-070","group":"power-grids","name":"АО «Новгородоблэлектро»","facts":"ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-071","group":"power-grids","name":"ПАО «Астраханская ЭСК»","facts":"ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-072","group":"power-grids","name":"АО «НЭСК»","facts":"ВЛК, воздушные выключатели.","profile":"Краснодар","region":"Краснодар","star":false,"allowed":true}
```

```reference
{"id":"esq-073","group":"power-grids","name":"ГУП РК «Крымэнерго»","facts":"ВЛК, воздушные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-074","group":"defense","name":"АО «Оборонэнерго»","facts":"ВЛК, воздушные выключатели.","profile":"Оборонный и военный сектор","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-075","group":"power-grids","name":"ООО ХК «СДС-Энерго»","facts":"вакуумные выключатели.","profile":"Кемерово","region":"Кемерово","star":false,"allowed":true}
```

```reference
{"id":"esq-076","group":"power-grids","name":"АО «Юго-Западная ЭСК»","facts":"вакуумные выключатели.","profile":"Энергетика — сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-077","group":"data-telecom","name":"АО «Транстелеком»","facts":"Коммутационное оборудование ESQ (ВЛК, воздушные выключатели); проект пересогласован с европейского бренда.","profile":"ЦОД, дата-центры","region":"Казахстан","star":true,"allowed":true}
```

```reference
{"id":"esq-078","group":"data-telecom","name":"ООО «Линкс»","facts":"Воздушные выключатели ESQ для дата-центров TIER III.","profile":"ЦОД, IaaS","region":"Санкт-Петербург","star":false,"allowed":true}
```

```reference
{"id":"esq-079","group":"data-telecom","name":"ПАО «МегаФон»","facts":"ячейки КРУ ESQ, вакуумные выключатели.","profile":"Телекоммуникации, связь","region":"Ленобласть, «Уткина заводь»","star":false,"allowed":true}
```

```reference
{"id":"esq-080","group":"data-telecom","name":"ООО «Дататайм»","facts":"распределительные шкафы ESQ, модульное, ВЛК, воздушные выключатели.","profile":"ЦОД","region":"Москва","star":false,"allowed":true}
```

```reference
{"id":"esq-081","group":"data-telecom","name":"ООО «ЭнергоТех Хай Энерджи»","facts":"силовой шкаф распределения для ЦОД.","profile":"Проектирование ЦОД","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-082","group":"data-telecom","name":"ПАО «Уфанет»","facts":"ВЛК, воздушные выключатели.","profile":"Телекоммуникации, связь","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-083","group":"data-telecom","name":"ООО «Сибирские сети»","facts":"Вакуумные выключатели.","profile":"Телекоммуникации, связь","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-084","group":"data-telecom","name":"ООО «Луганские сети»","facts":"вакуумные выключатели нагрузки 35 кВ.","profile":"Телекоммуникации, связь","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-085","group":"data-telecom","name":"ПАО «КБ Центр-Инвест»","facts":"модульное, ВЛК, воздушные и вакуумные выключатели.","profile":"банк","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-086","group":"utilities","name":"АО «Ямалкоммунэнерго»","facts":"вакуумные выключатели ESQ.","profile":"ЯНАО","region":"ЯНАО","star":false,"allowed":true}
```

```reference
{"id":"esq-087","group":"utilities","name":"ГУП «Леноблводоканал»","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-088","group":"utilities","name":"Люберецкий водоканал","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-089","group":"utilities","name":"ГУП «Ставрополькрайводоканал»","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-090","group":"utilities","name":"Сызраньводоканал","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-091","group":"utilities","name":"Чистополь-Водоканал","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-092","group":"utilities","name":"Водоканал-сервис (Канск)","facts":"ПЧ/УПП ESQ.","profile":"Водоканал, водоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-093","group":"utilities","name":"СГК — Енисейская ТГК (ТГК-13)","facts":"ПЧ/УПП ESQ.","profile":"ЖКХ","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-094","group":"utilities","name":"Выборгтеплоэнерго","facts":"ПЧ/УПП ESQ.","profile":"Теплоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-095","group":"utilities","name":"УТС Верхняя Пышма","facts":"ПЧ/УПП ESQ.","profile":"Теплоснабжение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-096","group":"utilities","name":"МУП РРЦ (Санкт-Петербург)","facts":"ПЧ/УПП ESQ.","profile":"ЖКХ","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-097","group":"utilities","name":"Псковские тепловые сети","facts":"ПЧ/УПП ESQ.","profile":"Теплоснабжение, тепловые сети","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-098","group":"chemical","name":"АО «Обнинскоргсинтез»","facts":"РУ-6 кВ и РУ-10 кВ на ячейках КРУ.ESQ, вакуумные выключатели.","profile":"Химия","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-099","group":"materials","name":"НАО «Салаватстекло Волга»","facts":"РУ-0,4 кВ 3200 А (2 шт) и 5000 А.","profile":"Производство стекла","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-100","group":"chemical","name":"ПАО «Уралкалий»","facts":"ВЛК, воздушные выключатели, ПЧ ESQ.","profile":"Березники","region":"Березники","star":false,"allowed":true}
```

```reference
{"id":"esq-101","group":"chemical","name":"АО «Башкирская содовая компания»","facts":"вакуумные выключатели.","profile":"Химия, производство соды","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-102","group":"chemical","name":"АО «Плазма Некст»","facts":"вакуумные выключатели.","profile":"Фармацевтика","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-103","group":"chemical","name":"ООО «Полипласт Северо-Запад»","facts":"главные распределительные щиты, ПЧ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-104","group":"chemical","name":"ЕвроХим — Новомосковский Азот","facts":"ПЧ ESQ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-105","group":"chemical","name":"Омский каучук","facts":"ПЧ ESQ.","profile":"Химия, производство каучука","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-106","group":"chemical","name":"Красноярский завод СК (СИБУР)","facts":"ПЧ ESQ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-107","group":"chemical","name":"ЭМЛАК","facts":"ПЧ ESQ.","profile":"Химия","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-108","group":"food","name":"АПХ «Мираторг»","facts":"модульное, магнитные контакторы, ВЛК, ПЧ ESQ.","profile":"Пищевая/АПК","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-109","group":"food","name":"Русагро-Белгород","facts":"Шкафы управления ESQ-Direct.","profile":"Пищевая промышленность, АПК","region":"Белгород","star":true,"allowed":true}
```

```reference
{"id":"esq-110","group":"food","name":"ООО «Птицефабрика Павловская»","facts":"распределительные щиты ESQ, ВЛК, воздушные выключатели.","profile":"Птицеводство, птицефабрика","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-111","group":"food","name":"ООО «ТК Толмачёвский»","facts":"воздушные, вакуумные выключатели, ЭВН.","profile":"АПК, агрохолдинг","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-112","group":"food","name":"ООО «Маслов»","facts":"ВЛК, воздушные выключатели, ЭВН.","profile":"Маслоэкстракция","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-113","group":"food","name":"ООО «Агропромкомплектация-Рязань»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Пищевая/АПК","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-114","group":"food","name":"ООО «Мария-Ра»","facts":"модульное, ВЛК, воздушные выключатели, ЭВН.","profile":"Продуктовый ритейл","region":"Сибирь","star":false,"allowed":true}
```

```reference
{"id":"esq-115","group":"food","name":"ООО «Русскарт»","facts":"воздушные выключатели ESQ.","profile":"Пищевая/АПК","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-116","group":"food","name":"ООО «Рузком»","facts":"воздушные выключатели ESQ.","profile":"Пищевая/АПК","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-117","group":"food","name":"ООО «Семь Холмов»","facts":"воздушные выключатели ESQ.","profile":"Пищевая/АПК","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-118","group":"construction","name":"ООО «ДорХан-Новосибирск»","facts":"пять подстанций 1600 и 2500 кВА, полностью собранных на ESQ.","profile":"группа DoorHan","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-119","group":"commercial","name":"ООО «Вертикаль»","facts":"РТП 4×1250 10/0,4 кВ на ESQ.","profile":"Коммерческая недвижимость, торговый центр","region":"Москва","star":true,"allowed":true}
```

```reference
{"id":"esq-120","group":"residential","name":"ООО «СЗ ЖК Яркий»","facts":"КРУ на вакуумных выключателях и ЭВН ESQ.","profile":"Жилая недвижимость, жилой комплекс","region":"Красногорск","star":true,"allowed":true}
```

```reference
{"id":"esq-121","group":"residential","name":"ООО «ВКБ-Новостройки»","facts":"коммутация ESQ для РУНН и РУВН.","profile":"Жилая недвижимость, застройщик","region":"Новороссийск","star":true,"allowed":true}
```

```reference
{"id":"esq-122","group":"residential","name":"ГК «Донстрой»","facts":"модульное, ВЛК, воздушные выключатели, ПЧ.","profile":"Жилая недвижимость, жилой комплекс","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-123","group":"residential","name":"ПАО «ГК «Самолёт»","facts":"модульное оборудование ESQ.","profile":"Жилая недвижимость","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-124","group":"construction","name":"ООО «Казань Экспо»","facts":"ВЛК, воздушные выключатели.","profile":"объекты саммита БРИКС","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-125","group":"construction","name":"ООО «Аэродинамика»","facts":"воздушные выключатели.","profile":"Аэропорты","region":"Сочи, Краснодар, Анапа","star":false,"allowed":true}
```

```reference
{"id":"esq-126","group":"construction","name":"ООО «Актуальные строительные технологии»","facts":"4 двойные КТП.","profile":"Екатеринбург","region":"Екатеринбург","star":false,"allowed":true}
```

```reference
{"id":"esq-127","group":"construction","name":"ООО СК «Прайд»","facts":"РП-6 кВ.","profile":"Уфа","region":"Уфа","star":false,"allowed":true}
```

```reference
{"id":"esq-128","group":"construction","name":"ТОО «Промстрой»","facts":"РУ-6 кВ на КРУ.ESQ для РП-145.","profile":"Казахстан","region":"Казахстан","star":false,"allowed":true}
```

```reference
{"id":"esq-129","group":"construction","name":"ГК «Точно»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-130","group":"construction","name":"Камастройинвест","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-131","group":"construction","name":"Евродом Групп","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-132","group":"construction","name":"ГК «СМУ №1 Ростов»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-133","group":"construction","name":"СЗ «СК-РДС»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-134","group":"construction","name":"СЗ «ССК Новороссийск»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-135","group":"construction","name":"«Тамерлан»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-136","group":"construction","name":"ТОО «Век-Тұмар»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-137","group":"construction","name":"АО «ОЭЗ ППТ Оренбуржье»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-138","group":"materials","name":"ООО «Кнауф Гипс Байкал»","facts":"РУ-35 кВ на 12 ячейках КРУ.ESQ-COMFORT-35 кВ, вакуумные выключатели 40,5 кВ.","profile":"Производство гипса","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-139","group":"materials","name":"ООО «БЗС»","facts":"ВЛК, воздушные выключатели.","profile":"Производство бетона","region":"Санкт-Петербург","star":false,"allowed":true}
```

```reference
{"id":"esq-140","group":"materials","name":"Завод ЖБИ «Стройиндустрия»","facts":"ВЛК, воздушные выключатели.","profile":"Производство железобетонных изделий, ЖБИ","region":"Пермь","star":false,"allowed":true}
```

```reference
{"id":"esq-141","group":"materials","name":"ООО «Завод Труд»","facts":"ВЛК, воздушные выключатели.","profile":"Барнаул","region":"Барнаул","star":false,"allowed":true}
```

```reference
{"id":"esq-142","group":"materials","name":"ООО «Стеклострой»","facts":"ВЛК, воздушные и вакуумные выключатели.","profile":"Производство стекла","region":"Грозный","star":false,"allowed":true}
```

```reference
{"id":"esq-143","group":"materials","name":"Невьянский цементник (Евроцемент)","facts":"ПЧ ESQ.","profile":"Производство цемента","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-144","group":"materials","name":"ХайдельбергЦемент Волга","facts":"ПЧ ESQ.","profile":"Производство цемента","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-145","group":"materials","name":"Боровичский комбинат огнеупоров","facts":"ПЧ ESQ.","profile":"Производство огнеупоров","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-146","group":"oem","name":"ООО «Газхолодтехника»","facts":"БМЗ КТПНУ полной заводской готовности, ВРУ-0,4 кВ ESQ, ЭВН.","profile":"Производство холодильного оборудования","region":"Москва","star":true,"allowed":true}
```

```reference
{"id":"esq-147","group":"oem","name":"АО «ПТП»","facts":"БМЗ 2КТПНУ, воздушные и вакуумные выключатели.","profile":"Железнодорожное машиностроение","region":"Энгельс","star":true,"allowed":true}
```

```reference
{"id":"esq-148","group":"oem","name":"АО «УЗГА»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Авиастроение","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-149","group":"defense","name":"ФКП НПО «Казанский завод точного машиностроения»","facts":"ВЛК, воздушные выключатели.","profile":"ОПК","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-150","group":"oem","name":"ОАО «Свердловский завод трансформаторов тока»","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Производство трансформаторов тока","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-151","group":"oem","name":"ООО «Биопродмаш»","facts":"модульное, ВЛК, ПЧ ESQ.","profile":"Машиностроение/OEM","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-152","group":"oem","name":"ООО «Купер»","facts":"ячейки КСО.ESQ-BASE.","profile":"Производство насосов","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-153","group":"oem","name":"ТОО «ПСМ Казахстан»","facts":"шкафы управления ESQ-Control.","profile":"Производство насосов","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-154","group":"oem","name":"ВЕЗА","facts":"ПЧ/УПП ESQ.","profile":"вентиляция","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-155","group":"oem","name":"Тайра НЭМЗ","facts":"ПЧ/УПП ESQ.","profile":"вентиляция","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-156","group":"oem","name":"Ульяновский крановый завод","facts":"ПЧ/УПП ESQ.","profile":"краны","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-157","group":"oem","name":"«Шарт»","facts":"ПЧ/УПП ESQ.","profile":"краны","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-158","group":"oem","name":"Барренс","facts":"ПЧ/УПП ESQ.","profile":"компрессоры","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-159","group":"oem","name":"Краснодарский компрессорный завод","facts":"ПЧ/УПП ESQ.","profile":"компрессоры","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-160","group":"oem","name":"Орелкомпрессормаш","facts":"ПЧ/УПП ESQ.","profile":"компрессоры","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-161","group":"oem","name":"СпецНефтеМаш","facts":"ПЧ/УПП ESQ.","profile":"нефтегазовое оборудование","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-162","group":"oem","name":"ЮгМаш","facts":"ПЧ/УПП ESQ.","profile":"нефтегазовое оборудование","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-163","group":"oem","name":"Шельф","facts":"ПЧ/УПП ESQ.","profile":"нефтегазовое оборудование","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-164","group":"oem","name":"ООО «Альфа Балт Инжиниринг»","facts":"16 РУ-6 кВ из трёх камер, ячейки КСО.ESQ-OPTIMA/EASY, РУ-10 кВ на КСО.ESQ, БМЗ повышающих подстанций 0,4/6 кВ.","profile":"Производство ДГУ, ДЭС, дизель-генераторных установок","region":"Санкт-Петербург","star":true,"allowed":true}
```

```reference
{"id":"esq-165","group":"switchboards","name":"ООО «Росэк»","facts":"РУ-10 кВ на 18 ячейках КРУ.ESQ.","profile":"Щитовое производство","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-166","group":"switchboards","name":"ООО «ДИ Групп»","facts":"РУ-6 кВ на малогабаритных КРУ.ESQ.Compact (16 ячеек), КСО.ESQ-OPTIMA.","profile":"Щитовое производство","region":"","star":true,"allowed":true}
```

```reference
{"id":"esq-167","group":"oem","name":"ООО «НГ-Энерго»","facts":"ячейки КСО.ESQ-OPTIMA и КСО.ESQ-EASY.","profile":"Производство ДГУ, ДЭС, дизель-генераторных установок","region":"Санкт-Петербург","star":false,"allowed":true}
```

```reference
{"id":"esq-168","group":"switchboards","name":"ООО «ЧЗМЭК»","facts":"комплектное РУ-6 кВ на КСО ESQ, ПЧ и УПП.","profile":"Челябинский завод мобильных энергоустановок","region":"Челябинский завод мобильных энергоустановок","star":false,"allowed":true}
```

```reference
{"id":"esq-169","group":"switchboards","name":"ООО «ЭТЗ «Энергорегион»","facts":"КРУ-Э.ESQ-EASY-FL.","profile":"Ижевск","region":"Ижевск","star":false,"allowed":true}
```

```reference
{"id":"esq-170","group":"oem","name":"ООО «Техэкспо»","facts":"РУ-6,3 кВ на КСО.ESQ.","profile":"Производство ДГУ, ДЭС, дизель-генераторных установок","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-171","group":"switchboards","name":"ТД «Электротехмонтаж» (ЭТМ)","facts":"РУ-10 кВ на КСО.","profile":"Щитовое производство","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-172","group":"switchboards","name":"ООО «Аггреко Евразия»","facts":"РУ-0,4 кВ.","profile":"Щитовое производство","region":"","star":false,"allowed":true}
```

```reference
{"id":"esq-173","group":"public","name":"Верховный суд","facts":"модульное, ВЛК, воздушные выключатели.","profile":"Санкт-Петербург","region":"Санкт-Петербург","star":false,"allowed":true}
```

```reference
{"id":"esq-174","group":"public","name":"Резиденция Президента Республики Казахстан","facts":"ВЛК, воздушные выключатели.","profile":"Шымкент","region":"Шымкент","star":false,"allowed":true}
```

```reference
{"id":"esq-175","group":"food","name":"Русагро-Тамбов","facts":"Шкафы управления ESQ-Direct.","profile":"Пищевая промышленность, АПК","region":"Тамбов","star":true,"allowed":true}
```

```reference
{"id":"esq-176","group":"construction","name":"СЗ «Урбанстрой»","facts":"Нет конкретных фактов оборудования в исходном перечне.","profile":"Строительство","region":"","star":false,"allowed":false}
```

```reference
{"id":"esq-177","group":"data-telecom","name":"Новый ЦОД Транстелекома в Астане","facts":"Будущий проект; состоявшаяся поставка не подтверждена.","profile":"ЦОД","region":"Астана","star":false,"allowed":false}
```

## Архив исходных фактов (не используется для отбора)

Сохранён для сверки оборудования, объёмов и происхождения. Старые группировки здесь не определяют разрешённые группы; действует поле `group` индивидуальной записи. Общие количества Русагро (52 и 118 шт.) не распределены между отдельными компаниями без дополнительной сверки.

### A. Нефтегаз
- ★ **ООО «Новатэк-Таркосаленефтегаз»** (ЯНАО, группа НОВАТЭК) — распредустройства ESQ, БМЗ ЗРУ с ЧРП для БКНС (БМЗ.ESQ), ПЧ 6 кВ ESQ, ВЛК, воздушные и вакуумные выключатели.
- ★ **ООО «Газпромнефть-Заполярье»** (группа «Газпром нефть») — высоковольтные ПЧ ESQ, модульное оборудование, ВЛК, воздушные и вакуумные выключатели.
- ★ **ООО «НКНП» (Нефтяная компания «Новый поток»)** (Оренбургская обл., Бузулук) — 4 подстанции на ESQ: 2КТП-2500-6/0,4 «АБК», 2КТП-2000 «Насосная», 2КТП-1600 «Технология», 2КТП-2000 «Скважины».
- **ПАО «НК «Роснефть»** (Самара, ХМАО) — вакуумные выключатели и вакуумные контакторы ESQ, ВЛК, воздушные, модульное; Шкаповское ГПП (Роснефть) — ПЧ ESQ.
- **ПАО «Газпром»** (КС «Хабаровская», магистральный газопровод) — воздушные выключатели, низковольтные ПЧ ESQ.
- **ООО «Газпромнефть Энергосистемы»** — оборудование РУ-10 кВ (секции 1С-10, 2С-10).
- **ООО «ГПН-Развитие»** (Тюмень, «Газпром нефть») — модульное, ВЛК, воздушные выключатели.
- **ООО «Лукойл-Западная Сибирь»** (Когалым) — модульное, ВЛК, воздушные выключатели.
- **ПАО «Татнефть»** (Альметьевск) — вакуумные выключатели и вакуумные контакторы ESQ.
- **ООО «Иркутская нефтяная компания»** — модульное, ВЛК, воздушные выключатели.
- **АО «Березкагаз Югра»** (ХМАО) — модульное, ВЛК, воздушные выключатели.
- **ПАО «СИБУР Холдинг»** — воздушные и вакуумные выключатели ESQ; **ПАО «Нижнекамскнефтехим» (СИБУР)** — ретрофит ESQ 0,4 кВ (2000/630/400 А).
- **ОАО «Новатэк-Арктикгаз»** — система бесперебойного питания.
- **ООО «Торглайн»** (Сахалин, оператор топливоснабжения) — КТП-1000-10/0,4, воздушные выключатели, ЭВН ESQ.

### B. Горнодобыча
- ★ **ООО «Амур Минералс» (РМК)** (Хабаровский край, Малмыжское месторождение) — КРУ 10 кВ (13 и 20 ячеек, в БМЗ), КРУ 35 кВ (4 и 11 ячеек), СОПТ, трансформаторы ТСЛ, КРМ 10 кВ, передвижные КТПН, модульное оборудование и выключатели ESQ.
- ★ **АО «Тарынская золоторудная компания»** (Якутия, GV Gold) — двухтрансформаторная КТПН 2×1600 кВА с сухими трансформаторами и ячейками КРУ, выключатели ESQ.
- ★ **Русская платина / ООО «Амур Золото»** — 5 комплектных трансформаторных подстанций (2×1600, 1000, 2×400, 1250 кВА).
- ★ **ООО «Восточная горнорудная компания»** (Сахалин, уголь) — КТП-1000 с ПЧ 250 и 560 кВт в блочно-модульном исполнении, ПЧ ESQ.
- **АК «АЛРОСА» (ПАО)** (Мирный) — воздушные и вакуумные выключатели, ЭВН, ПЧ ESQ; **АО «Алмазы Анабара»** (АЛРОСА) — РУ-0,4 кВ ESQ в утеплённом БМЗ.
- **АО «Рудник Каральвеем»** (Чукотка) — модульное, ВЛК, воздушные, вакуумные выключатели 6-10 кВ.
- **ЗАО «Зангезурский медно-молибденовый комбинат»** (Армения) — модульное, ВЛК, воздушные выключатели.
- **АО «Далур»** (Курганская обл., Росатом) — вакуумные выключатели ESQ.
- **ООО «Желтугинская ГРК»** (Забайкалье) — РТП-6 кВ, передвижные КТП, вакуумные выключатели.
- **АО ХК «Якутуголь»** — передвижная подстанция 2КТПНУ, воздушные и вакуумные выключатели.
- **АО «Михайловский ГОК им. А.В. Варичева»** (Металлоинвест) — подстанция КТПВ, воздушные выключатели, ПЧ.
- **АО «Русский уголь» (Кузбасская ТК)** — станция запуска и управления насосами в утеплённом БМЗ (Plug and Work ESQ).
- **ТОО «Актюбинская медная компания»** (Казахстан) — модульное оборудование, вакуумные выключатели.
- **ПАО «Высочайший» (GV Gold)** — шкафы управления ESQ, ПЧ.
- ПЧ/УПП ESQ: Лебединский ГОК и Михайловский ГОК (Металлоинвест), Качканарский ГОК (ЕВРАЗ), Быстринский ГРК (Норникель), Высокогорский ГОК, Урупский ГОК (УГМК), Башмедь, Мечел «Южный Кузбасс», ГДК «Берелех», Васильевский рудник, Прииск Соловьёвский.

### C. Металлургия
- ★ **ООО «ЭН+ Торговый дом»** (Иркутск, группа En+ / РУСАЛ) — комплектное оборудование ПС 35/10 кВ, КРУ ESQ на вакуумных выключателях.
- ★ **ПАО «Магнитогорский металлургический комбинат»** — КТП-2500-10/0,4 кВ, модульное, ВЛК, воздушные и вакуумные выключатели, ПЧ и УПП ESQ.
- ★ **АО «Балаково-Центролит»** — РП РУ-10 кВ на КРУ ESQ, БМЗ 2КТПНУ полной заводской готовности на НКУ ESQ и КСО ESQ, выключатели.
- ★ **ПАО «Челябинский трубопрокатный завод»** — двухтрансформаторная подстанция КТП.ESQ 2×1600/6/0,4, ПЧ.
- **ПАО «Северсталь»** — внутрицеховая подстанция 2КТП-10/0,4 кВ, УПП ESQ.
- **ООО «Эмпилс-Цинк»** (Ростов-на-Дону) — блочно-комплектная 2БКТП 1250/6/0,4 кВ, воздушные и вакуумные выключатели.
- **ЕВРАЗ НТМК** (Нижний Тагил) — УПП ESQ; **ЕВРАЗ ЗСМК** — ПЧ ESQ.
- **ЗАО «НТЗ Тэм-по»** (трубы, Набережные Челны) — ВЛК, воздушные и вакуумные выключатели.
- **ПАО «Челябинский кузнечно-прессовый завод»** — воздушные выключатели.
- **ООО «Алтайский литейный завод»** — вакуумные выключатели.
- ПЧ/УПП ESQ: ОЭМК (Металлоинвест), Тагмет, ВМЗ (ОМК), ВСМПО-АВИСМА, НЛМК-Урал, Колпинский трубный завод.

### D. Энергетика
Генерация:
- ★ **ПАО «ТГК-14»** (Чита) — РУ-6 кВ на 12 ячейках КСО.ESQ, вакуумные выключатели, ВРУ-0,4 кВ.
- ★ **МП «ТЭЦ Бишкек»** (Кыргызстан) — РУ-0,4 кВ, 25 ячеек КРУ.ESQ-COMFORT (1600 и 630 А, ТН), выключатели ESQ.
- **АО «ТГК-1»** (Санкт-Петербург) — модульное, ВЛК, воздушные выключатели.
Сети и сбыт:
- ★ **АО «ИЭСК»** (Иркутск) — комплектное оборудование подстанций, вакуумные выключатели.
- ★ **ООО «Евросибэнерго ТД»** — комплектное оборудование ПС 35/10 кВ «Садоводство», УПП.
- **ПАО «Россети Ленэнерго», ПАО «Россети Юг», АО «Донэнерго»** — модульное, ВЛК, воздушные выключатели.
- **ПАО «Магаданэнерго»** (РусГидро) — модульное, ВЛК, воздушные выключатели, ЭВН.
- **АО «Сетевая компания»** (Татарстан), **АО «Новгородоблэлектро»**, **ПАО «Астраханская ЭСК»**, **АО «НЭСК»** (Краснодар), **ГУП РК «Крымэнерго»**, **АО «Оборонэнерго»** — ВЛК, воздушные выключатели.
- **ООО ХК «СДС-Энерго»** (Кемерово), **АО «Юго-Западная ЭСК»** — вакуумные выключатели.
Аргумент для сетевых: оборудование 0,4 кВ ESQ прошло испытания в АО «Россети НТЦ»; воздушные выключатели и ВЛК ESQ имеют сертификат РЭЦ «Сделано в России».

### E. ЦОД / телеком / IT
- ★ **АО «Транстелеком»** (Казахстан) — крупнейший держатель дата-центров в стране; проект был рассчитан на европейском бренде, пересогласован на коммутационное оборудование ESQ (ВЛК, воздушные выключатели).
- **ООО «Линкс»** (Санкт-Петербург) — дата-центры TIER III, топ-10 IaaS-провайдеров России; воздушные выключатели ESQ.
- **ПАО «МегаФон»** (Ленобласть, «Уткина заводь») — ячейки КРУ ESQ, вакуумные выключатели.
- **ООО «Дататайм»** (Москва) — распределительные шкафы ESQ, модульное, ВЛК, воздушные выключатели.
- **ООО «ЭнергоТех Хай Энерджи»** (проектный институт) — силовой шкаф распределения для ЦОД.
- **ПАО «Уфанет»** — ВЛК, воздушные; **ООО «Сибирские сети»** — вакуумные; **ООО «Луганские сети»** — вакуумные выключатели нагрузки 35 кВ.
- **ПАО «КБ Центр-Инвест»** (банк) — модульное, ВЛК, воздушные и вакуумные выключатели.

### F. ЖКХ / водоканалы / теплоснабжение
- **АО «Ямалкоммунэнерго»** (ЯНАО) — вакуумные выключатели ESQ.
- ПЧ/УПП ESQ: ГУП «Леноблводоканал», Люберецкий водоканал, ГУП «Ставрополькрайводоканал», Сызраньводоканал, Чистополь-Водоканал, Водоканал-сервис (Канск), СГК — Енисейская ТГК (ТГК-13), Выборгтеплоэнерго, УТС Верхняя Пышма, МУП РРЦ (Санкт-Петербург), Псковские тепловые сети.

### G. Химия, нефтехимия, фарма
- ★ **АО «Обнинскоргсинтез»** — РУ-6 кВ и РУ-10 кВ на ячейках КРУ.ESQ, вакуумные выключатели.
- ★ **НАО «Салаватстекло Волга»** — РУ-0,4 кВ 3200 А (2 шт) и 5000 А.
- **ПАО «Уралкалий»** (Березники) — ВЛК, воздушные выключатели, ПЧ ESQ.
- **АО «Башкирская содовая компания»** — вакуумные выключатели.
- **ПАО «Нижнекамскнефтехим» (СИБУР)** — ретрофит ESQ 0,4 кВ.
- **АО «Плазма Некст»** (фармацевтика) — вакуумные выключатели.
- **ООО «Полипласт Северо-Запад»** — главные распределительные щиты, ПЧ.
- ПЧ ESQ: ЕвроХим — Новомосковский Азот, Омский каучук, Красноярский завод СК (СИБУР), ЭМЛАК.

### H. Пищевая промышленность / АПК / ритейл
- ★ **АПХ «Мираторг»** — модульное, магнитные контакторы, ВЛК, ПЧ ESQ.
- ★ **Русагро-Белгород / Русагро-Тамбов** — шкафы управления ESQ-Direct (52 и 118 шт).
- **ООО «Птицефабрика Павловская»** («Русское поле») — распределительные щиты ESQ, ВЛК, воздушные выключатели.
- **ООО «ТК Толмачёвский»** (агрохолдинг «Горкунов») — воздушные, вакуумные выключатели, ЭВН.
- **ООО «Маслов»** (маслоэкстракция) — ВЛК, воздушные выключатели, ЭВН.
- **ООО «Агропромкомплектация-Рязань»** — модульное, ВЛК, воздушные выключатели.
- **ООО «Мария-Ра»** (продуктовый ритейл Сибири) — модульное, ВЛК, воздушные выключатели, ЭВН.
- **ООО «Русскарт», ООО «Рузком», ООО «Семь Холмов»** — воздушные выключатели ESQ.

### I. Строительство и недвижимость
- ★ **ООО «ДорХан-Новосибирск»** (группа DoorHan) — пять подстанций 1600 и 2500 кВА, полностью собранных на ESQ.
- ★ **ООО «Вертикаль»** (Москва, ТЦ «Остров») — РТП 4×1250 10/0,4 кВ на ESQ.
- ★ **ООО «СЗ ЖК Яркий»** (Красногорск, ЖК «Рига Хилл») — КРУ на вакуумных выключателях и ЭВН ESQ.
- ★ **ООО «ВКБ-Новостройки»** (Новороссийск, топ-5 застройщиков России) — коммутация ESQ для РУНН и РУВН.
- **ГК «Донстрой»** (ЖК «Событие») — модульное, ВЛК, воздушные выключатели, ПЧ.
- **ПАО «ГК «Самолёт»** — модульное оборудование ESQ.
- **ООО «Казань Экспо»** (объекты саммита БРИКС) — ВЛК, воздушные выключатели.
- **ООО «Аэродинамика»** (аэропорты Сочи, Краснодар, Анапа) — воздушные выключатели.
- **ООО «Актуальные строительные технологии»** (Екатеринбург) — 4 двойные КТП; **ООО СК «Прайд»** (Уфа) — РП-6 кВ.
- **ТОО «Промстрой»** (Казахстан) — РУ-6 кВ на КРУ.ESQ для РП-145.
- Также: ГК «Точно», Камастройинвест / СЗ «Урбанстрой», Евродом Групп, ГК «СМУ №1 Ростов», СЗ «СК-РДС», СЗ «ССК Новороссийск», «Тамерлан», ТОО «Век-Тұмар», АО «ОЭЗ ППТ Оренбуржье».

### J. Стройматериалы
- ★ **ООО «Кнауф Гипс Байкал»** — РУ-35 кВ на 12 ячейках КРУ.ESQ-COMFORT-35 кВ, вакуумные выключатели 40,5 кВ.
- **ООО «БЗС»** (бетонный завод, Санкт-Петербург), **Завод ЖБИ «Стройиндустрия»** (Пермь), **ООО «Завод Труд»** (Барнаул) — ВЛК, воздушные выключатели.
- **ООО «Стеклострой»** (Грозный) — ВЛК, воздушные и вакуумные выключатели.
- ПЧ ESQ: Невьянский цементник (Евроцемент), ХайдельбергЦемент Волга, Боровичский комбинат огнеупоров.

### K. Машиностроение, ОПК, транспорт, OEM
- ★ **ООО «Газхолодтехника»** (Москва) — БМЗ КТПНУ полной заводской готовности, ВРУ-0,4 кВ ESQ, ЭВН.
- ★ **АО «ПТП»** (Энгельс, ж/д машиностроение) — БМЗ 2КТПНУ, воздушные и вакуумные выключатели.
- **АО «УЗГА»** (авиастроение) — модульное, ВЛК, воздушные выключатели.
- **ФКП НПО «Казанский завод точного машиностроения»** (ОПК) — ВЛК, воздушные выключатели.
- **ОАО «Свердловский завод трансформаторов тока»** — модульное, ВЛК, воздушные выключатели.
- **ООО «Биопродмаш»** — модульное, ВЛК, ПЧ ESQ.
- **ООО «Купер»** (насосы) — ячейки КСО.ESQ-BASE; **ТОО «ПСМ Казахстан»** (насосы) — шкафы управления ESQ-Control.
- ПЧ/УПП ESQ у производителей оборудования: вентиляция — ВЕЗА, Тайра НЭМЗ; краны — Ульяновский крановый завод, «Шарт»; компрессоры — Барренс, Краснодарский компрессорный завод, Орелкомпрессормаш; нефтегазовое оборудование — СпецНефтеМаш, ЮгМаш, Шельф.

### L. Щитовое производство и партнёры (собирают на ESQ)
- ★ **ООО «Альфа Балт Инжиниринг»** (Санкт-Петербург, ДГУ) — 16 РУ-6 кВ из трёх камер, ячейки КСО.ESQ-OPTIMA/EASY, РУ-10 кВ на КСО.ESQ, БМЗ повышающих подстанций 0,4/6 кВ.
- ★ **ООО «Росэк»** — РУ-10 кВ на 18 ячейках КРУ.ESQ.
- ★ **ООО «ДИ Групп»** — РУ-6 кВ на малогабаритных КРУ.ESQ.Compact (16 ячеек), КСО.ESQ-OPTIMA.
- **ООО «НГ-Энерго»** (Санкт-Петербург, ДГУ) — ячейки КСО.ESQ-OPTIMA и КСО.ESQ-EASY.
- **ООО «ЧЗМЭК»** (Челябинский завод мобильных энергоустановок) — комплектное РУ-6 кВ на КСО ESQ, ПЧ и УПП.
- **ООО «ЭТЗ «Энергорегион»** (Ижевск) — КРУ-Э.ESQ-EASY-FL.
- **ООО «Техэкспо»** (ДГУ) — РУ-6,3 кВ на КСО.ESQ.
- **ТД «Электротехмонтаж» (ЭТМ)** — РУ-10 кВ на КСО.
- **ООО «Аггреко Евразия»** — РУ-0,4 кВ.

### M. Госсектор и прочее
- **Верховный суд** (Санкт-Петербург) — модульное, ВЛК, воздушные выключатели.
- **Резиденция Президента Республики Казахстан** (Шымкент) — ВЛК, воздушные выключатели.
- **ПАО «КБ Центр-Инвест»** — см. раздел E.
