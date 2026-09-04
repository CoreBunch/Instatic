# Inspector redesign — audyt implementacji i TODO

> Dokument roboczy przebudowy panelu Properties według prototypu HTML
> (`.tmp/mock/index.html`, serwowany na `http://localhost:5599` — konfiguracja
> `mock` w `.claude/launch.json`). Źródłem prawdy jest makieta + referencyjny
> HTML panelu przekazany przez autora. Stan na 2026-08-28 (weryfikacja
> przeglądarkowa + testowa — patrz § 5).

> **Opis stanu docelowego** — z czego panel się składa i co każda kontrolka
> robi — żyje osobno: [`inspector-panel.md`](inspector-panel.md). Ten dokument
> śledzi wyłącznie postęp wdrożenia.

Legenda: ✅ zrobione · 🟡 częściowe (jest funkcja, wygląd/kształt do dociągnięcia) · ❌ brak · ❓ decyzja autora potrzebna

---

## 1. Fundament (zrobione)

- ✅ **Skala kontrolek** — `--control-height-sm/‑/‑lg` (24/30/36px), `--control-row-gap` (10px), `--control-radius` (8px) w `src/styles/globals.css`; jeden typ `FieldSize` (`src/ui/fieldSize.ts`) dla Input/Select/ColorInput; wysokości Button xs/sm/md na tokenach.
- ✅ **Pola bez ramek** — `--bg-surface-2` na `--bg-surface`, hover → `--bg-surface-3`, ramka `--overlay-30` dopiero na focusie, rogi 8px (Input, Select, ColorInput).
- ✅ **Anatomia wiersza** — ControlRow: etykieta 100px (`--control-label-column`) + wariant `narrow` 52px (pod popouty), wiersz wyśrodkowany na `--control-height`; kropka akcentowa `--accent-1` przy etykietach ustawionych właściwości.
- ✅ **Segmenty** — `SegmentedControl` z `look="tiles"` (zlane kafle, szew 1px `--border-muted`) podpięty do rodziny Layout/Position; tor z pigułką (`track`) zostaje dla par Yes/No.
- ✅ **Nagłówki sekcji** — caret `>` (rotujący), nazwa, licznik mono; cały nagłówek klikalny (`src/ui/components/Section/`).
- ✅ **Tła** — rama edytora `--bg-body: #0d0d0e`; zadokowany panel jest PRZEZROCZYSTY nad ramą (jeden ton z toolbarem — decyzja autora 2026-08-27); pływający panel zostaje kartą `--bg-surface: #1b1b1b`.
- ✅ **Taksonomia sekcji** — Layout / Position / Size / Spacing / **Styles** / Typography / Effects / **Transforms** / Interaction (`cssControlTypes.ts`); stare sekcje Background + Border scalone w Styles.
- ✅ **StylesSection** (`StylesSection.tsx`) — Opacity (pole + suwak, preview w trakcie przeciągania, commit na puszczeniu), Visible Yes/No (nowy klucz `visibility` w `CSSPropertyBag`), Fill (BackgroundFillControl: kolor + gradient), Image, Overflow, Radius, Border (BorderControl inline — docelowo popout, patrz TODO), Shadows, Advanced.
- ✅ **TypographySection** (`TypographySection.tsx`) — Font, Weight, Size ⊕ lh (duo), Spacing (letterSpacing), Align, Color, Advanced.
- ✅ **Gap x/y** — `GapInput` jako para pól nad shorthandem `gap` (równe osie → jedna wartość).
- ✅ **Layout: ogon w Advanced** — alignSelf/justifySelf/flex/rowGap/columnGap/gridColumn/gridRow za disclosure; overflow przeniesiony do Styles.
- ✅ Sekcje wizualne respektują filtr wyszukiwania (`visibleProperties`).

---

## 2. Braki względem referencyjnego panelu — TODO

### 2.1 Chrome panelu

- [x] ✅ **panel-head** — `NodeHeader` zamyka się tagiem elementu (`getNodeHtmlTag`) przy prawej krawędzi: mono, `--text-subtle`, bez chrome przycisku. Nazwa mówi, jak autor nazwał tę rzecz; tag — czym ona jest w dokumencie.
- [~] 🟡 **classbar** — wskaźnik aktywnego breakpointu **jest** (`SelectorPillStack`, mono przy prawej krawędzi, tytuł „Editing the … viewport"): dotąd fakt, na który viewport lecą edycje, był widoczny tylko w pasku canvasu, daleko od pól, którymi rządzi. Zostaje kształt paska: produkcja ma stałe pole „Add or create selector…", makieta — pigułkę `+ class`, która to pole otwiera.
- [x] ✅ **Przycisk `+` w nagłówku sekcji** — `SectionAddMenu.tsx`: propmenu w stylu makiety (wyszukiwarka „Type to search…" z lupką, lista pełnowierszowych pozycji). Listuje TYLKO właściwości do dodania (katalog `SECTION_ADDABLE_PROPERTIES` w `cssControlTypes.ts` minus już ustawione); klik zapisuje default i wiersz pojawia się w sekcji. Sekcje bez ogona (Position/Spacing/Effects/…) nie renderują `+`.
- [x] ✅ **Advanced usunięte** — disclosure `AdvancedRows` skasowany we wszystkich sekcjach; ogon właściwości renderuje się jako zwykłe wiersze dopiero gdy ustawiony (dodawanie przez `+`).
- [x] ✅ **`rowx`** — przycisk usuwania siedzi w zarezerwowanej kolumnie po prawej (30×30, hover `--bg-surface-3`). Dwa glify z `@ui/icons/inspectorGlyphs`, dwa znaczenia: **kreska −** (`RemoveDashGlyph`) na zwykłych wierszach właściwości i na wierszach efektów (`ClassPropertyRow.tsx`, `EffectsSection.tsx`) — kasuje właściwość z reguły; **×** (`RemoveXGlyph`) *wewnątrz* pola koloru (SwatchRow, `BorderControl`) — czyści samą wartość, zgodnie z kontraktem § 2.13.
- [x] ✅ Nagłówek sekcji: caret = SVG z prototypu 1:1; licznik przy nazwie; linia `--border-muted` zamykająca każdą sekcję (+ otwierająca pierwszą).

### 2.2 Layout

- [x] ✅ Wiersz **Type** z etykietą (Layout i Position).
- [x] ✅ **Columns / Rows** = pole + **StepGroup** − | + (`GridTrackControl` przepisany; własny szablon wpisuje się w to samo pole, kafle wtedy nieaktywne).
- [x] ~~✅ **Padding w Layout**~~ — USUNIĘTE 2026-09-04 na polecenie autora: dublował box Spacing (jeden komponent na jedną rzecz). `PaddingRow.tsx` skasowany; padding edytuje się wyłącznie w sekcji Spacing.

### 2.3 Position

- [x] ✅ **Type jako select** — rozstrzygnięte: zostaje DropdownSwitcher, ale stan „inna wartość” wygląda jak makietowy `.chipvalue`: sama wartość (`Block`) w tym samym torze co chevron, bez kickera i bez kwadratowego ✕. Czyszczenie przeniosło się do menu (pozycja „Clear display/position”).
- [x] ✅ **Inset** — `InsetBoxControl` (w folderze `SpacingBoxControl/`, na tym samym module CSS): boks z fasetowanymi pasmami i wartością w każdym paśmie, a w środku **pinbox** — cztery belki, przypięta świeci akcentem. Pin **blokuje krawędź**: pole zostaje czytelne, ale nie przyjmuje kursora, kroku ani przeciągnięcia (`readOnly`, nie `disabled`). Blokada to stan panelu na czas sesji — CSS nie ma gdzie zapisać „ta krawędź jest przypięta", a wymyślanie klucza wstawiłoby meble UI do dokumentu. Stara siatka 2×2 (`DirectionInput`, `.positionDirectionsGrid`) skasowana.
- [x] ✅ **Z Index** = pole + StepGroup − | + (zgodne z makietą; audyt 2026-08-28 błędnie policzył to jako brak).

### 2.4 Size

- [x] ✅ **Sekcja przepisana do prototypu** — `sizeGroup` + klamra-ratiolock (ramiona rysowane pseudo-elementami, kłódka otwarta/zamknięta, stan `aria-pressed` na `--accent-3`), wiersze `fused` (wartość `minmax(76px,1fr)` ⊕ tryb `minmax(0,88px)`). Wiersz „Min Max" usunięty — ograniczenia dodaje się przez `+` i pojawiają się jako zwykłe wiersze.
- [x] ✅ **Stepper w polu** — chevrony ▲▼ w 16px kolumnie, chowane do hover/focus (`Input.onStep` + `TokenAwareInput.onStep`); klik steppuje część liczbową zachowując jednostkę (`80%` → `81%`), `auto`/`fit-content` nie reagują.
- [x] ✅ **Tryb Height: Viewport** (`100vh`) — Width bez tej opcji, jak w makiecie.
- [x] ✅ **Przeciąganie po liczbie** — w prymitywie `Input`, więc dostaje je każde pole ze stepperem naraz: próg 4px odróżnia klik (kursor w tekście) od przeciągania, potem 1 krok na 4px, Shift ×10. Wcześniej `cursor: ew-resize` obiecywał gest, którego nie było. `onStep` przyjmuje teraz dowolną liczbę kroków, nie tylko ±1.
- [x] ✅ **Stepper wszędzie, gdzie wartość jest liczbą** — dołożony do: Gap x/y, Padding (zbiorcze + cztery strony), rogi Radiusa, Font size, Line height (kroki po 0.1 dla wartości bez jednostki), przesunięcia Insetu (schodzą poniżej zera), parametry efektów i każdego wiersza z tokenami długości (m.in. Spacing/letter-spacing) przez `ClassPropertyRow`.

### 2.5 Spacing

- [x] ✅ **spacebox** — CSS boksu (fasety, `.boxHeader`, `.sideval`, trapezy) jest 1:1 z makietą; 2026-08-30 doszedł brakujący **wiersz z etykietą** („Spacing" po lewej) i makietowe zawijanie szerokich kontrolek (patrz § 2.14).

### 2.6 Styles

- [x] ✅ **Fill → bez obrazu** (decyzja autora 2026-08-30, uchyla wcześniejszy plan „obraz w tym samym pickerze") — zakładka **Image** wyleciała z pickera w całości: obrazem tła zajmuje się wyłącznie osobny wiersz **Image** (`BackgroundImageControl`). Usunięte jako martwy kod: prop `images` (`ColorValueInput` / `TokenizedColorField` / `ColorInput` / `ColorPicker`), `onPickImage`, arm `'image'` w `FillMode`, `ImageState` / `ImageType` / `ImagePosition` / `parseImageUrl` w `fillState.ts`, pane Image + jego CSS. `initialFill` z zapisanym `url(…)` degraduje do solida jak każda nieparsowalna wartość.
- [x] ✅ **SwatchRow** (wariant B — jeden wiersz na kolor) — prymityw `src/ui/components/SwatchRow`; `ColorValueInput` renderuje go (look `swatch`: chip · nazwa · ×) we wszystkich wierszach koloru — Fill, Border (popout), Typography→Color, kolory efektów.
- [x] ✅ **Opacity** — pole to NumberField (hover-stepper, `inputMode="decimal"` — NIE `type="number"`: kontrolowany number input czyści każdy niepełny ułamek `0.` do pustego i kasowałby wartość w trakcie pisania); kolumna pola 88px jak w makiecie; szyna 3px malowana na pseudo-elemencie toru, więc knob 12px stoi na jej środku (`margin-top: -4.5px` na webkicie).
  - [ ] ❓ Wartość jest w skali 0–1 (jak makieta). Jeśli ma być w %, jak w narzędziach typu Figma — decyzja autora.
- [x] ✅ **Radius** — `RadiusRow` na `ScopeGroup`: pole „wszystkie rogi" + tryb per-corner (TL/TR/BR/BL, emisja longhandów `border*Radius`, auto-relink gdy rogi wracają do jednej wartości).
- [x] ✅ **Border → popout** — `BorderPopoutRow` jedzie na `FloatingPanel`, tej samej powłoce co picker koloru i parametry efektu: otwiera się PRZY swoim wierszu zamiast na zapamiętanej pozycji biurka, i ginie od klika poza sobą. `SwatchRow` dostał `triggerRef`, żeby popout miał się czego uchwycić.
- [x] ✅ **Shadows → popout** — cienie przeniosły się do sekcji Effects jako nazwane wiersze (§2.9): Position (x/y), Blur, Spread, Color w popoucie, emisja do listy `boxShadow`. Wiersz „Shadows" z surowym polem w Styles zniknął.

### 2.7 Typography

- [x] ✅ **Align** jako rząd ikon — `AlignRow` (left/center/right/justify, przyciski ikonowe z `onClear`).
- [x] ✅ **Color** jako SwatchRow — `ColorValueInput` w look `swatch` (chip · nazwa · ×), zgodnie z kontraktem § 2.13.
- [ ] ❓ **Spacing: druga oś `w`** (word-spacing) — brak `wordSpacing` w `CSSPropertyBag`. Dodać klucz + drugą komórkę duo, czy zostawić samo letter-spacing?

### 2.8 Nowe prymitywy do zbudowania

- [x] ✅ **StepGroup** — `src/ui/components/StepGroup` (użyty w Columns/Rows; Z Index — do wpięcia).
- [x] ✅ **NumberField** — hover-stepper (`onStep`) plus scrub przeciąganiem i Shift×10, wszystko w prymitywie `Input` (`src/ui/components/Input/Input.tsx`, patrz 2.4).
- [x] ✅ **Wspólne glify** — `src/ui/icons/inspectorGlyphs.tsx`: cienkie marki 8–12px (caret, chevron steppera, lupka, kreska usuwania, kłódka, box wszystkie-strony / osobno), których nie ma w pixel-art-icons. Jedno miejsce zamiast kopii w każdym panelu (bramka Gate 3 zakazuje inline SVG w `src/admin/pages/site/`).
- [x] ✅ **SwatchRow** — patrz 2.6.
- [x] ✅ **Popout** — `FloatingPanel` (`src/ui/components/FloatingPanel`): jedna powłoka dla pickera koloru, `BorderPopoutRow` i `EffectParams`; otwiera się przy triggerze, znika od klika poza sobą. Po zamontowaniu doklampowuje pozycję z realnego pomiaru (`ResizeObserver` + `resize` okna), więc zawsze stoi w całości na ekranie. Jeden panel naraz: pole koloru w popoucie **wsuwa** widok pickera w ten sam panel (`FloatingPanelDrillView` — strzałka wstecz + tytuł „Border color" / „Shadow color"), zamiast otwierać drugi.
- [x] ✅ **PropMenu** — `SectionAddMenu` (właściwości CSS) + `EffectAddMenu` (katalog efektów) — patrz 2.1 / 2.9.

### 2.9 Effects

- [x] ✅ **efxlist** — `EffectsSection.tsx`: wiersze efektów z ikoną typu, wartością wiodącą i kreską usuwania; klik w pole otwiera popout parametrów (`EffectParams`) w `FloatingPanel`, otwarty popout maluje obrys pola i ikonę na akcent. Cztery efekty z czystym odpowiednikiem w CSS — Drop shadow / Inner shadow nad listą `box-shadow`, Layer blur nad `filter: blur()`, Background blur nad `backdrop-filter: blur()` (tłumaczenie w obie strony: `effectsModel.ts`). **Bez oka** — decyzja autora 2026-08-28: CSS nie zna wyłączonego cienia, więc stan „ukryty" nie miałby gdzie mieszkać bez nowego klucza w modelu. Texture i Glass poza zakresem (nie są jedną właściwością CSS).
- [x] ✅ **`+` w Effects** — `EffectAddMenu.tsx`: katalog efektów zamiast właściwości CSS, efekt już obecny wygaszony i z ptaszkiem. Dodanie cienia dopisuje wpis do listy zamiast nadpisywać istniejący.
- [x] ✅ **Sekcja pusta domyślnie** (decyzja autora 2026-08-30) — `transition` / `animation` nie stoją już jako puste wiersze: `EffectAddMenu` listuje je pod katalogiem efektów, wiersz pojawia się dopiero po dodaniu i ma uchwyt usuwania.
- [ ] ❌ **Blend** (select) — wymaga klucza `mixBlendMode` w `CSSPropertyBag` + enum options.
- [ ] ❓ **HOVER EFFECT popout** (makieta: Opacity/Scale/Rotate/Skew/Offset/Fill/Shadow/Transition „Spring") — to stany `:hover` + transition; wymaga decyzji jak mapować na styleRules (kontekst `:hover` istnieje w edytorze warunków?). Do omówienia przed implementacją.

### 2.10 Transforms

- [x] ✅ **Sekcja pusta domyślnie** (decyzja autora 2026-08-30) — `transform` / `transformOrigin` nie stoją na sztywno; dodaje się je przez `+` w nagłówku, a dodany wiersz ma uchwyt usuwania.
- [ ] ❌ **Rotate** (pole ° + segmented 2D/3D), **Scale** (x/y duo), **Origin** (select) — zadaniowe wiersze parsujące/emitujące `transform` + `transformOrigin` (dziś surowe pola tekstowe).

### 2.11 Interaction / Accessibility

- [x] ✅ **Sekcja pusta domyślnie** (decyzja autora 2026-08-30) — Cursor / Pointer events / User select / Scroll behavior nie stoją na sztywno; wchodzą przez `+` (`SECTION_ADDABLE_PROPERTIES`), wiersz ma uchwyt usuwania. Cursor pozostaje selectem (generic row wystarcza).
- [ ] ❓ **Accessibility** — makieta ma pustą sekcję. Co ma zawierać (aria-label? role? tabindex — to atrybuty HTML, nie CSS)? Nie tworzę pustej sekcji bez decyzji.

### 2.12 ADVANCED LAYOUT popout

- [ ] ❓ Makieta pokazuje popout „ADVANCED LAYOUT" (Columns Auto/Fixed, Width Min, Height Fill Container, Align) — doprecyzować czym różni się od sekcji Layout/Size zanim powstanie.

---

## 2.13 Kontrakt decyzji — wiersz Fill (2026-08-28)

Ustalone z autorem w rundzie pytań. **Nie podważać bez jego zgody.**

### Każdy wiersz koloru w inspektorze

- Kształt: `chip · nazwa wartości · ×`. **Bez pola tekstowego** — wpisywanie hexa
  i wyszukiwarka tokenów żyją w popoucie pickera.
- Nazwa wartości: slug tokenu (`Grey-900`), rodzaj gradientu (`Linear`),
  w przeciwnym razie hex bez `#` (`E50B0B`).
- `×` **wewnątrz** pola, przy prawej krawędzi (nie w zewnętrznej kolumnie).
- `×` widoczny **zawsze, gdy pole ma wartość**; puste pole — brak `×`.
  - **Wyjątek: `select`.** Strzałka i `×` nigdy nie pokazują się naraz — chevron jest stanem spoczynku (to jedyny sygnał, że kontrolka się rozwija), a `×` wchodzi na jego miejsce dopiero na hover/focus. Oba zajmują tę samą ramkę 20px, więc wartość nie przeskakuje.
  - **Wyjątek: wiersz efektu (`efxrow`).** Nie ma stanu „pusty” — sam efekt *jest* wartością — więc jeden klik usuwa wiersz, bez dwóch kroków. Oko i `×` siedzą wewnątrz pola: powierzchnię niesie cały wiersz, a trigger jest przezroczysty (w `<button>` nie wolno zagnieżdzić przycisków).
- **Jeden `×`, dwa kroki:** klik czyści wartość → wiersz zostaje pusty; kolejny
  klik na pustym wierszu usuwa wiersz z sekcji. Zewnętrzna kolumna `rowx`
  znika z wierszy koloru.

### Fill + obraz — ZREWIDOWANE 2026-08-30

Decyzja autora uchyla kontrakt z 2026-08-28: picker Fill **nie ma** zakładki
Image. Obrazem tła zajmuje się wyłącznie osobny wiersz **Image**
(`BackgroundImageControl`); popout Fill zostaje przy zakładkach
`Solid · Linear · Radial · Conic`. Cały arm obrazu (prop `images`,
`onPickImage`, `FillMode: 'image'`, `ImageState`, pane w pickerze) został
usunięty jako martwy kod — patrz § 2.6.

### Jeden krzyżyk (2026-08-28)

W inspektorze obowiązuje **wyłącznie** kreskowy `RemoveXGlyph` (`@ui/icons/inspectorGlyphs`, 8×8, `stroke-width 1.5`). Pikselowy `CloseIcon` z `pixel-art-icons` został z niego usunięty — 10 użyć w 9 plikach `PropertiesPanel/` i `property-controls/`, wcześniej w sześciu różnych rozmiarach (8/10/11/12/13/16 px). Reszta admina (media, dashboard, dane, AI) zostaje na `CloseIcon` — to nadal domowy zestaw.

- [ ] ❌ **`MediaPickerField` wnosi pikselowy × do inspektora** przez `MediaLibraryControl` (wiersz Image). Używa `CloseIcon size={13}` — sparametryzować (prop wybierający glif) albo dać mu kreskowy ×; dzieli plik ze stroną Media, gdzie pixel-art ma zostać. (Zakładka Image w pickerze Fill wypadła 2026-08-30, więc popoutu Fill już nie dotyczy.)

### Fazy

- **Faza 1 = D2** — wygląd + kształt JSX. Kontrolki klikają się na stanie
  lokalnym, **nie emitują CSS**. Bramki testowe aktualizowane w tej samej zmianie.
  Zakres: **tylko wiersz Fill** (Typography→Color, Border→Color i Shadows
  świadomie poza zakresem tej rundy, choć dzielą `ColorValueInput`).
- **Faza 2 = D3** — nieaktualna po rewizji 2026-08-30: wiersz Image zostaje
  osobno, picker Fill emituje tylko kolory i gradienty.

### Trzy głębokości edycji (słownik dla kolejnych rund)

- **D1** — tylko `*.module.css`. Zero ryzyka, zero testów.
- **D2** — kształt wiersza w JSX. Rusza bramki `ClassPropertyRow`,
  `PropertyControlRenderer`, `propertiesPanel-redesign`.
- **D3** — model + emisja CSS: `fillState.ts`, `CSSPropertyBag`, publisher.

### Workflow pracy nad wierszem

1. Jeden wiersz naraz. 2. Autor wkleja wzorzec → audyt „gdzie to żyje +
jaka głębokość". 3. 3–4 pytania **z opcjami**, nigdy otwarte. 4. Faza 1 →
zrzut ekranu → poprawki → dopiero potem Faza 2. 5. Decyzje lądują tutaj.

---

## 2.14 Audyt autora 2026-08-30 — naprawione rozjazdy

Autor porównał produkcję z makietą (screenshoty) i zgłosił listę rozjazdów.
Wszystko poniżej wdrożone i sprawdzone w przeglądarce tego samego dnia:

- **Puste sekcje Effects / Transforms / Interaction** — patrz § 2.9–2.11:
  żadnych wierszy na sztywno, wszystko przez `+`, dodane wiersze usuwalne.
- **Zawijanie szerokich kontrolek** (makieta `.row:has(> .spacebox)` /
  `.insetbox` / `.mediafield`) — wiersz jest flexem z `flex-wrap`: etykieta
  trzyma kolumnę 100px, kontrolka (`flex: 1 1 220px`, mediafield 200px)
  zostaje obok przy szerokim panelu i schodzi POD etykietę w wąskim doku.
  Wdrożone jako `ControlRow wide` (Inset, nowy wiersz „Spacing") i
  przebudowany `BackgroundImageControl` (etykieta „Image" + kolumna pola).
- **Ucinana wartość insetu** („-419px" → „-419p…") — pola góra/dół w
  `.box--inset` poszerzone do 68px (pełne pasmo i tak daje im miejsce);
  lewe/prawe zostają 44px, ograniczone pasmem 48px.
- **Dwutonowe wyłączone pole Radius** — `ScopeGroup` malował `--overlay-5`
  na wewnętrznym inpucie, a wrapper ze stepperem trzymał własne tło.
  Wypełnienie przeniesione na wrapper (`span[data-disabled]`), kolumna
  steppera schowana — jak makietowy `.scopegroup[data-mode="parts"] > .field`.
- **Znikające okna przy edycji koloru bordera** — klik w zagnieżdżony picker
  (portal do `<body>`) był dla popoutu bordera „klikiem poza" i zamykał oba.
  Rozwiązane u źródła (2026-08-30): picker koloru w popoucie **nie jest już
  drugim panelem** — wsuwa się w ten sam `FloatingPanel`
  (`FloatingPanelDrillView`, strzałka wstecz + kontekstowy tytuł). Ochrona
  przed „klikiem poza" została tylko dla menu portalowanych PO panelu
  (`[role="menu"]` / `[role="listbox"]` — to drugie naprawia też zamykanie
  popoutu przez listę selecta stylu bordera).
- **Pola liczbowe** — każde pole ze stepperem odpowiada też na klawiaturę:
  ↑/↓ krokuje (Shift ×10) w prymitywie `Input`, `TokenAwareInput` przy kroku
  wychodzi z trybu edycji, żeby nowa wartość wróciła do widocznego draftu;
  Z-index dostał `onStep` (stepper w polu + scrub + strzałki). Pola zostają
  `type="text"` + `inputMode` — świadomie, jak makieta i notatka przy Opacity
  (kontrolowany `type="number"` czyści niedokończone ułamki).

---

## 2.15 Audyt autora 2026-08-30 — runda 2 (wdrożona)

Druga porcja uwag autora z tego samego dnia, wdrożona i sprawdzona w
przeglądarce:

- **Dynamiczne wartości w Spacing i Inset** — pole boczne rośnie do treści
  (`field-sizing: content` za `@supports`; stałe szerokości zostają jako
  fallback), więc „1000px" czy „-1234px" widać w całości. Żeby wartość mogła
  wyjść poza pasmo, input przestał być DZIECKIEM trapezowego segmentu (jego
  `clip-path` przycinał wszystko poza pasmem) — jest bratem segmentu,
  pozycjonowanym na tym samym `.box`, z `z-index: 1` nad zagnieżdżonym
  pasmem. Tooltip przy przepełnieniu działa w obu boksach (Inset miał go już
  wcześniej — `tooltipOnOverflow`).
- **`UnitField`** (`property-controls/UnitField.tsx`) — długość jako DWA
  kontrolki: pole liczbowe (odrzuca nie-liczby, stepper/scrub/↑↓) + select
  jednostki (px/%/em/rem/vw/vh) ze słowami kluczowymi (`Auto`, `None`,
  `Normal`) w tym samym selekcie. Wybór słowa wygasza pole liczbowe; wybór
  jednostki konwertuje widoczną liczbę. Wartość nieparsowalna (`calc(…)`)
  pokazuje się dosłownie i nie jest niszczona przy odczycie. Katalog
  `LENGTH_PROPERTIES` w `cssControlTypes.ts` — dziś: min/max width/height,
  rowGap, columnGap, outlineOffset, letterSpacing (wiersz „Spacing"
  w Typography). Aspect ratio dostał osobne pole ratio (`16/9`, `1.5` —
  nic innego). Columns/Rows w Layout: `inputMode="numeric"` + kroki ↑↓/scrub
  na liczniku; surowy szablon (`200px 1fr`) nadal wchodzi w to samo pole —
  to świadomy wyjątek, nie przeoczenie.
- **Puste sekcje nie otwierają się** — `Section` dostał `collapsible`:
  sekcja bez wierszy (Effects/Transforms/Interaction) ma wygaszony caret
  i martwy nagłówek; pierwszy dodany wiersz ją otwiera (keyed remount),
  usunięcie ostatniego z powrotem zamyka i blokuje.

---

## 2.16 Elementy tekstowe (decyzje 2026-08-30, zrewidowane tego samego dnia)

Decyzje autora (odpowiedzi na pytania z opcjami — nie podważać bez zgody):

1. **Wykrywanie**: element tekstowy = moduł deklarujący `inlineTextEdit`
   (dziś: `base.text`, `base.button`, `base.link`; heading to tag Texta).
2. **Content**: rewizja 2026-08-30 — promowany wiersz Content nad sekcjami
   USUNIĘTY. Prop `inlineTextEdit` renderuje się w sekcji modułu („Text")
   jak każda inna kontrolka, z etykietą ze schematu.
3. **Kolejność**: Position ZAWSZE pierwsza; dla elementów tekstowych
   Typography wskakuje na drugie miejsce (zaraz za Position), reszta w
   kolejności katalogu (rail lustrzanie — wspólny helper
   `getOrderedStyleSections`, sygnał z `definition.inlineTextEdit`).

---

## 2.17 Audyt autora 2026-09-04 — stabilność, spójność, praktyczność (wdrożone)

Zasady autora z tej rundy (patrz też pamięć projektu): **user nie czyta** —
każda wartość ma być do wyklikania, wzorcem jest popout efektu; **dwa
kliknięcia mają pokazać, do czego coś służy**; **jeden komponent na jedną
rzecz**; kolory WSZYSTKICH pól i grup przycisków w edytorze = kolory
inspektora; testy tylko z tego obszaru (`bun test src/__tests__/panels/
src/__tests__/property-controls/ src/__tests__/ui/ src/__tests__/architecture/`,
~35 s), nigdy pełny zestaw.

- **Zakres palety** (root cause „lewa strona ma inne inputy") — remap
  `--bg-surface-2/3/4` + `--border-*` przestał być prywatny dla `.panelDocked`:
  `globals.css` ma dwie drabinki (`--card-*`, `--panel-*`) i przełącznik
  `[data-surface="chrome" | "card"]` (inspector-panel.md §10). Stemple:
  oba sidebary, toolbar i `FloatingPanel` = `chrome`; Agent, pływający
  wariant panelu, `ColorTokenCard`, `StepList` = `card`. `FloatingPanel`
  maluje się teraz na `--bg-body` (jak zadokowany panel) i zwija akcenty do
  `--panel-accent`. `SearchBar` na `--control-height` (było sztywne 28px).
- **Grupy przycisków** — `look="tiles"` w chrome edytora (Layers/Site/Code/
  Media, FrameworkPanel, CanvasContextSelector, ModuleInserterDialog,
  MediaLibraryControl, UrlControl, BackgroundImageControl); prop
  `activeSurface="recessed"` skasowany (jedyny konsument).
- **Wiersz Image** — `BackgroundImageControl` na `ControlRow wide` zamiast
  własnej etykiety (etykieta była grubsza i przesunięta względem reszty).
- **Visible** — nieustawione czyta się jako „Yes" (initial CSS), kropka mówi,
  czy wartość jest zapisana.
- **Radius** — wejście w tryb per-corner przy pustym stanie zapisuje bieżący
  promień do czterech rogów (drugi klik POKAZUJE, co robi tryb); render-time
  auto-relink skasowany (wpisanie tej samej wartości w czwarty róg nie
  wyrzuca już z trybu).
- **Popout wartości (Spacing/Inset)** — liczba ⊕ jednostka to teraz wspólny
  `UnitField` (nowe propsy `fieldSize`, `className`, `onUnitChange`), z
  `auto` jako słowem w selekcie — pole trzyma `auto`; chip `Auto` = kwadrat
  2×2, siatka 4 kolumny (§6.6).
- **Object position / Background position** — nowy `PositionControl`
  (`property-controls/`): pole-trigger + popout z siatką 3×3 kotwic i polami
  X/Y na `UnitField`; wpięty w `ClassPropertyRow`. Test:
  `positionControl.test.tsx`.
- **„Pokaż wszystkie odstępy"** — pin (oko) w slocie akcji NAGŁÓWKA SEKCJI
  Spacing (`SpacingOverlayToggle`; sekcja nie ma `+`, więc miejsce było
  wolne — uwaga autora); sesyjne `spacingOverlayPinned` w `selectionSlice`,
  `SpacingHighlightOverlay` rysuje osiem pasów (box × bok) zamiast tylko
  edytowanego; przeżywa zmianę zaznaczenia (§6.3). Test w
  `spacingHighlight.test.tsx`.
- **Kłódka proporcji w Size działa też na canvasie** — stan przeniesiony
  z `useState` do sesyjnego `sizeRatioLocked` w `selectionSlice` (reset przy
  zmianie zaznaczenia); `useCanvasResizeDrag` przy włączonej kłódce trzyma
  proporcje (krawędź wyprowadza drugą oś, róg idzie za osią z większym
  ruchem), Shift odwraca na czas jednego przeciągnięcia. Pola Width/Height
  skalowały drugi wymiar już wcześniej (commit i — od tej rundy — podgląd).
- **Border „nic nie robi" — przyczyna źródłowa** (audyt funkcjonalny:
  klucze NIE giną nigdzie w torze panel → store → `bagToCSS` → scena; giną
  WARTOŚCI): pole Width w popoucie było jedynym polem długości poza
  `UnitField`/`TokenAwareInput` i zapisywało gołe `400` → `border-top-width:
  400` = niepoprawny CSS, przeglądarka odrzuca deklarację. Naprawa u źródła:
  Width i Offset w popoucie na `UnitField`, klucze `border*Width` w
  `LENGTH_PROPERTIES` (generyczne wiersze też). Dwa sąsiednie błędy tej
  samej rodziny: (a) `bagToDeclarations` emitowało deklaracje w kolejności
  wstawienia, więc shorthand `border` dodany PO longhandach je nadpisywał —
  teraz `orderShorthandsFirst` (test `bagToCssShorthandOrder.test.ts`);
  (b) line-height: wpisane `1.5` dostawało `px` (`resolveTokenValue`) —
  nowy parametr `implicitUnit`, pole Line height przekazuje `''`.
  Pierwszy klik w pusty wiersz Border sieje 1px solid `#ffffff` na cztery
  strony jednym commitem (`borderPopoutRow.test.tsx`).
- **Border, runda 2** (autor: „edycja poszczególnych ścian blokuje, Width
  nie da się ustawić"): (1) `BorderControl` miał render-time auto-relink
  (`if (!linked && borderUniform) setLinked(true)`) — po seedzie cztery
  strony są identyczne, więc wejście w tryb „osobno" natychmiast wracało do
  „wszystkie"; skasowany, jak wcześniej w Radius. (2) `UnitField` w parze
  Width ⊕ kafle miał siatkę sekcyjną (1fr ⊕ 88px) w ~90px — pole liczby
  znikało, zostawał sam select jednostki; własny podział `.widthField`
  (1fr ⊕ 52px) + popout 288px. (3) Trzy kontrolki jednego stanu (klikalny
  chip „Editing all sides", kafle all/side, edge box) → chip jest teraz
  tekstem (`role="status"`), scope zmieniają kafle i edge box. Test
  „per-side mode stays per-side".
- **Kolory — regresja z tej rundy, naprawiona**: stemple
  `data-surface="chrome"` na obu sidebarach NIE weszły do kodu (edycja
  perlem z `\n` w regexie cicho nie dopasowała), a remap z `.panelDocked` był
  już usunięty — inspektor dostał JAŚNIEJSZĄ drabinkę kart zamiast ciemnej
  panelowej („na odwrót"). Stemple dodane; zasada bez zmian: ciemna drabinka
  inspektora idzie na wszystkie pola chrome.
- **Trzy wiersze „martwe" na scenie z założenia** — `cursor`, `userSelect`
  (reset ramki projektowej) i `transition` (wyłączane, żeby edycja nie
  płynęła): wiersz pokazuje pod kontrolką jednowierszową notę „Applies on
  the published page — the canvas hides it". Wyłączanie `transition`
  przeniesione z `EditorChromeInjector` (wszystkie ramki) do
  `iframeBodyReset` (tylko ramki projektowe) — ramka live zachowuje
  przejścia jak strona.
- **Scrub na całym polu liczbowym** — gest działał od dawna na całym polu
  (próg 4 px), ale natywny kursor tekstowy na `<input>` chował afordancję do
  16-px kolumny steppera („trzeba wycelować"). `Input.module.css`: kursor
  `ew-resize` także na samym inpucie, `text` dopiero po fokusie.
  **Stabilność** (uwaga autora „nad canvasem głupieje"): gest nie
  przechwytywał wskaźnika, więc nad iframe'em sceny ruchy ginęły, a po
  powrocie przychodziła jedna wielka delta = skok wartości; do tego każdy
  ruch myszy (przy 1000 Hz setki na sekundę) robił osobny commit. Teraz:
  `setPointerCapture` po przekroczeniu progu (iframe nie widzi zdarzeń,
  zaznaczanie tekstu nie startuje), kroki zbierane i aplikowane raz na
  klatkę, puszczenie dopłukuje resztę. Test `numberFieldScrub.test.tsx`.
  **Odbijanie 740 → 730 → 720 → 730** (uwaga autora, bug starszy niż ta
  runda): `beginScrub` łapał domknięcie `step` z chwili pointerdown, więc
  każda partia liczyła się od wartości SPRZED przeciągania. Teraz `stepRef`
  (aktualne domknięcie, odświeżane w efekcie) + bramka ack: kolejna partia
  czeka do 3 klatek, aż pole pokaże poprzedni krok — krok liczy się zawsze
  od bieżącej wartości. Test „every batch steps from the CURRENT value".
  **Natychmiast (cel autora)** — scrub to teraz SESJA z podziałem
  podgląd/commit, jak gesty canvasu: `Input.onScrub(total, 'move'|'end')`
  daje co klatkę SUMĘ kroków od chwytu (baza zamrożona = zero problemu
  nieświeżej bazy, zero czekania na ack), pole podgląda `start + total`
  przez `onPreview` (tani kanał `previewClassStyles` /
  `previewInlineStyles`, żadnych zapisów do store), a puszczenie robi JEDEN
  commit = jeden wpis undo na przeciągnięcie. Żeby to działało w jednym
  miejscu, wiersze przestały same commitować w `onStep`: `TokenAwareInput`
  ma `stepValue(current, delta) → next` (czysta matematyka), a chevrony,
  strzałki i scrub jadą na niej (`applyStep` / `handleScrub`). Migracja:
  ClassPropertyRow, GapInput, Size (`stepDimension` skasowany — commit idzie
  przez `commitDimension`), Inset, Radius (dostał kanał podglądu), Typography
  (font size, line height). `UnitField` dostał `onPreview`/`onClearPreview`
  i tę samą sesję (ClassPropertyRow, popout wartości, PositionControl,
  Border width); Opacity — sesję na własnym `dragValue`. Bez kanału
  podglądu (EffectParams, GridTrack, z-index) scrub nadal commituje partiami
  z bramką ack. Testy: `tokenAwareInputScrub.test.tsx`, `numberFieldScrub`
  („onScrub gets the TOTAL…").
- **Padding w Layout usunięty** (polecenie autora) — dublował box Spacing;
  `PaddingRow.tsx` skasowany, `onChangeMany` zniknęło z propsów Layout.
- **Scrollbar pickera koloru** — `.picker` nie ma już sztywnych 244px
  (2px przepełnienia w panelu 244px z ramką 1px + `overflow-y: auto`).
- **Uchwyty promienia na canvasie** (dogrywka tego samego dnia) — cztery
  okrągłe kropki wewnątrz rogów zaznaczenia, na przekątnej rogu, `radius ×
  zoom` od narożnika; ciągnięcie do środka zaokrągla. Które rogi — decyduje
  tryb wiersza Radius: jego przełącznik „wszystkie / osobno" przeniósł się z
  lokalnego stanu wiersza do sesyjnego `radiusScope` w `selectionSlice`
  (reset przy zmianie zaznaczenia, jak piny insetu), więc kropka w trybie
  „osobno" zaokrągla tylko swój róg, w trybie „wszystkie" — cztery; Alt
  odwraca tryb na czas przeciągania. Pisze longhandy `border*Radius` (te same
  klucze co wiersz) i czyści zapisany shorthand. Żeby nie powielać resize'a,
  szkielet gestu (guardy, preview inline, echo do `canvasGesturePreview`,
  jeden commit, Escape, blokada na nie-bazowym breakpoincie) wyjechał do
  `canvas/canvasStyleGesture.ts`; `useCanvasResizeDrag` i nowy
  `useCanvasRadiusDrag` niosą tylko własną matematykę. Test:
  `useCanvasRadiusDrag.test.tsx`; opis w `docs/editor.md` §2.
- Martwe: `onTextChange`/`onTextBlur` pass-throughs w `ColorValueInput`,
  nieaktualne docstringi (StylesSection „Advanced disclosure"), wpisy w §5.
- **Zero lagu między panelem a sceną** (uwaga autora: „efekt natychmiastowy,
  żadnych płynnych przesunięć") — trzy źródła opóźnienia, trzy naprawy:
  (1) cel inline nie miał podglądu na żywo (`onPreview={noop}` w
  `InlineStyleComposer`) — scena czekała na blur; teraz jest kanał
  `previewInlineStyles` w store (rodzeństwo `previewClassStyles`), który
  `NodeRenderer` nakłada na zapisany worek jednego węzła; (2) `transition`
  ze stylów strony animowało każdą edycję — `EditorChromeInjector` wyłącza
  przejścia na `[data-node-id]` i potomkach (nielayerowane, bez `!important`;
  animacje zostają); (3) klamra proporcji w Size skalowała drugi wymiar
  dopiero przy commicie — `resolveDimension` służy teraz commitowi I
  podglądowi. Dodatkowo kropka radiusa straciła swoje 80 ms `transition`.

**Nadal otwarte po tej rundzie** (niezrobione świadomie — wymagają decyzji
lub osobnego PR): Transforms Rotate/Scale/Origin (§2.10); Blend (§2.9); `background` shorthand
jest w sekcji Styles, ale nie renderuje go żaden wiersz i jest wykluczony z
Custom properties (zaimportowany `background: url(…)` niewidoczny); filtr
wyszukiwania stylów omija Layout/Size/Position/Spacing; `rowGap`/`columnGap`/
`outlineOffset` bez słowa kluczowego (nie da się wrócić do `normal`);
`aspectRatio` dodany z `+` zapisuje `0`; pikselowy `CloseIcon` wchodzi do
inspektora z `SegmentedControl`, `FloatingPanel`, `TokenStylesSection`,
`MediaPickerField`; chipy Media (FilterBar) i `CanvasModeToggle` to nadal
Buttony na `--overlay-*`, nie kafle.

---

## 3. Kolejność proponowana

Kroki 1–4 i 6 z pierwotnej listy są zrobione (PropMenu, StepGroup,
NumberField, Popout + SwatchRow, chrome panelu). Zostało, w kolejności:

1. ~~Fill → obraz: dokończenie~~ — nieaktualne: rewizja 2026-08-30 usunęła
   arm obrazu z pickera zamiast go dokańczać (§ 2.6, § 2.13).
2. ~~Rozbicie `ColorPicker.tsx`~~ — zrobione niejako samo: po usunięciu
   zakładki Image plik ma ~548 linii, poniżej bramki 700.
3. **Transforms** (§ 2.10) — zadaniowe wiersze Rotate/Scale/Origin.
4. **Blend** (§ 2.9) — nowy klucz `mixBlendMode`.
5. Szlify: `MediaPickerField` z pikselowym × (§ 2.13).

Punkty oznaczone ❓ (Opacity w %, wordSpacing, Accessibility, HOVER EFFECT,
ADVANCED LAYOUT) wymagają decyzji autora przed implementacją.

---

## 4. Weryfikacja

```sh
bun run build   # tsc -b && vite build
bun test src/__tests__/panels/ src/__tests__/property-controls/ src/__tests__/ui/ src/__tests__/architecture/
bun run lint
```

### Automatyczna kontrola zgodności z prototypem

`src/__tests__/architecture/inspector-prototype-parity.test.ts` czyta
`.tmp/mock/index.html` (ten sam plik, który serwuje `localhost:5599`) i
porównuje jego wartości z naszym CSS: skala kontrolek, kolumna etykiety
(100/52px), tory `.fused` w Size, geometria klamry proporcji, wypełnienia pól
i stepper. Rozjazd = czerwony test, nie „ktoś kiedyś zauważy na screenshocie".

```sh
bun test src/__tests__/architecture/inspector-prototype-parity.test.ts
```

Gdy prototypu nie ma na dysku (`.tmp/` jest nietrackowane), bramka sama się
pomija — CI i świeże klony zostają zielone. **Dokładając kolejny fragment
makiety, dopisz do niej asercję** — to jest miejsce, w którym „spójne z
prototypem" przestaje być kwestią oka.

Znane, **niezwiązane z redesignem** faile (równoległe prace / stare bramki — nie naprawiać w tym wątku):
`admin spacing tokens` (MediaPickerField, IconPicker), `CodeMirror lazy-load`, `dispatcher HTML pipeline`, `Error boundary gate`, `Keybindings registry`, `Circular dependencies`, `plugin bootstrap artifacts` (`bun run bootstrap:sync`), `AgentPanel` (formatowanie liczb zależne od locale), `PP-20b` (bramka nieaktualna po commicie `fc89efcb` — osobny task).

---

## 5. Weryfikacja 2026-08-28

Pełny przebieg: parity + suity panelowe + architektura + build + lint +
smoke test w przeglądarce (dev na :5173, zalogowany edytor, `.nw-hero` /
`.nw-section`).

**Zielone:** `inspector-prototype-parity` (6 pass), `panels/` +
`property-controls/` (507 pass — 3 faile to znane AgentPanel×2 i PP-20b),
`ui/` (139 pass), `bun run build`, `bun run lint`, konsola przeglądarki bez
błędów. W przeglądarce potwierdzone działanie: pełna taksonomia sekcji +
szyna nawigacji, Position (inset + piny + steppery, Z-index ze StepGroup),
Size (klamra ratio, tryby Fixed/Relative/Fill/Fit + Viewport tylko w Height),
Layout (kafle Flex/Grid, gap x/y, padding zbiorczy/per-side), Spacing box,
Styles (Opacity pole+suwak, Visible Yes/No, Radius per-corner, Border „Add…"),
Typography (Align ikonowy, Color jako SwatchRow), Effects („Add effect"),
picker Fill z zakładkami Solid/Linear/Radial/Conic/Image (zakładka Image
usunięta później, 2026-08-30 — § 2.13), eyedropper,
HEX/RGB/HSL, tokeny, kąt gradientu ze stepperem.

**Czerwone, w zakresie redesignu** (nowe pozycje TODO):

- ~~`module-size-budgets` — `ColorPicker.tsx` 733 linie (bramka 700)~~ —
  rozwiązane 2026-08-30: usunięcie zakładki Image zbiło plik do ~548 linii.
- ~~`bundle-size-budgets` — `AdminCanvasEditorBody` 791.3 kB vs budżet
  761.7 kB (pomiar na świeżym buildzie). Wzrost z prac nad gradientami
  (picker + gizmo na canvasie)~~ — rozwiązane: budżet podniesiony świadomie
  do 880 000 B w `src/__tests__/architecture/bundle-size-budgets.test.ts`,
  z uzasadnieniem w `rationale` (redesign inspektora — sekcje stylów,
  pływające popouty, overlay spacingu, drag resize/free-move na canvasie).
- ~~Zakładka **Image** w pickerze: „Choose Image…" disabled, siatka Position
  3×3~~ — rozwiązane 2026-08-30: cała zakładka usunięta (§ 2.6, § 2.13).
