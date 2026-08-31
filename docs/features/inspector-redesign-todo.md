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
- [x] ✅ **`rowx`** — przycisk usuwania wiersza: zawsze widoczny **×** (`RemoveXGlyph` z `@ui/icons/inspectorGlyphs` — ten sam, którego używają SwatchRow i BorderControl) w zarezerwowanej kolumnie po prawej (30×30, hover `--bg-surface-3`). Wcześniejsza kreska − była niespójna z resztą panelu; `RemoveDashGlyph` skasowany.
- [x] ✅ Nagłówek sekcji: caret = SVG z prototypu 1:1; licznik przy nazwie; linia `--border-muted` zamykająca każdą sekcję (+ otwierająca pierwszą).

### 2.2 Layout

- [x] ✅ Wiersz **Type** z etykietą (Layout i Position).
- [x] ✅ **Columns / Rows** = pole + **StepGroup** − | + (`GridTrackControl` przepisany; własny szablon wpisuje się w to samo pole, kafle wtedy nieaktywne).
- [x] ✅ **Padding w Layout** — pole „wszystkie strony" (4 propy jednym commitem, „Mixed" przy różnych) + kafle zakresu; tryb „osobno" = rząd T/R/B/L pod spodem, w kolumnie kontrolek, pola pełnej wysokości, tagi pod polami.

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
- [x] 🟡 **NumberField** — hover-stepper gotowy w prymitywie `Input` (`onStep`); zostaje drag + Shift×10 (patrz 2.4).
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
- `bundle-size-budgets` — `AdminCanvasEditorBody` 791.3 kB vs budżet
  761.7 kB (pomiar na świeżym buildzie). Wzrost z prac nad gradientami
  (picker + gizmo na canvasie); albo lazy boundary, albo świadome
  podniesienie budżetu z notką.
- ~~Zakładka **Image** w pickerze: „Choose Image…" disabled, siatka Position
  3×3~~ — rozwiązane 2026-08-30: cała zakładka usunięta (§ 2.6, § 2.13).
