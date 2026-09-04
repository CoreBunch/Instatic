# Panel Properties — specyfikacja kontrolek

> Opis tego, co panel właściwości **robi** i **z czego się składa**, spisany
> z żywego prototypu `.tmp/mock/index.html` (konfiguracja `mock`
> w `.claude/launch.json`, `http://localhost:5599`).
>
> Ten dokument opisuje **stan docelowy**. Postęp wdrożenia w kodzie śledzi
> [`inspector-redesign-todo.md`](inspector-redesign-todo.md).

---

## 1. Powłoka panelu

```
.app-dock                 fixed, prawa krawędź okna, tło --doc-bg
├── .splitter             uchwyt szerokości: strefa 11px, kreska 1px
└── .panel-dock
    └── .panel            SCROLLER · grid: 1fr + 32px · scrollbar-gutter: stable
        ├── .panel-content
        │   ├── .panel-head    nazwa węzła + tag typu, 38px, kreska pod spodem
        │   ├── .tabs          Styles / Attributes
        │   ├── .classbar      pigułka klasy + znacznik breakpointu
        │   └── .sec × 10      sekcje właściwości
        └── .rail             sticky top, ikony kategorii
```

**Panel nie jest kartą.** Siedzi wprost na tonie chrome (`--doc-bg` = `#0d0d0e`),
bez wypełnienia i bez obrysu. Rail jest **lepką prawą kolumną tego samego
scrollera**, nie sąsiadem — dzięki temu pasek przewijania wypada za nim, a nie
między nim a treścią.

Szerokość doku: `MIN 304px`, `MAX 560px`, domyślnie `330px`. Splitter zapisuje
`--panel-w` na `documentElement`.

---

## 2. Anatomia wiersza

```css
.row {
    display: grid;
    grid-template-columns: var(--label-column) minmax(0, 1fr);
    gap: var(--space-s);
    align-items: center;
    min-height: var(--control-height);
}
```

| miara | token | wartość |
|---|---|---|
| kolumna etykiety | `--label-column` | 100px (52px w popoucie, wariant `narrow`) |
| wysokość kontrolki | `--control-height` | 30px |
| odstęp wiersza | `--control-row-gap` | 10px |
| promień kontrolki | `--control-radius` | 8px |

Odstęp między wierszami niesie **`gap` kontenera**, nie margines wiersza.
Reguła `.row + .row { margin-top }` żyje wyłącznie w płytach specimenów
(`.stage > .row + .row`) — wszędzie indziej dodawałaby się do `gap`.

Wiersze wyższe niż jedna kontrolka przełączają się na `align-items: start`
i dają etykiecie `min-height: var(--control-height)`, żeby siedziała w osi
pierwszej kontrolki, a nie na środku całości.

W kodzie ta anatomia ma **jedną implementację**: współdzielony prymityw
`ControlRow` (`@ui/components/ControlRow`). Poza etykietą i kolumną kontrolki
niesie sygnał „ustawione" (`isSet` → kropka akcentowa `--accent-1` przed
etykietą + `data-state="set"|"unset"` na wierszu), wariant `narrow` (52px w
popoutach), wariant `wide` (kontrolka zawija się POD etykietę w wąskim doku —
Inset, Spacing) oraz `testId`. Sekcje wizualne (Size, Layout, Position,
Styles, Typography) i generyczne wiersze `ClassPropertyRow` używają tego
samego komponentu, więc etykiety liczą się do piksela w całym panelu. Wiersze
kompozytowe, które same rysują swoją siatkę (`ScopeGroup` — Radius),
biorą samą etykietę przez `ControlRowLabel`.

---

## 3. Sekcje

Kolejność w panelu:

| # | sekcja | wiersze |
|---|---|---|
| 1 | **Position** | Type · Inset · Z Index |
| 2 | **Size** | Width · Height |
| 3 | **Layout** | Type · Columns · Rows · Align · Gap |
| 4 | **Spacing** | boks margin/padding |
| 5 | **Styles** | Opacity · Visible · Fill · Image · Overflow · Radius · Border · Shadows |
| 6 | **Typography** | Font · Weight · Size · Spacing · Align · Color |
| 7 | **Effects** | lista efektów + Blend |
| 8 | **Transforms** | Rotate · Scale · Origin |
| 9 | **Interaction** | Cursor *(zwinięta)* |
| 10 | **Accessibility** | *(zwinięta, pusta)* |

Nagłówek sekcji: `caret · nazwa · +` przy prawej krawędzi. **Cały nagłówek jest
przełącznikiem zwijania**; `+` to jedyny przycisk o własnym znaczeniu (otwiera menu
właściwości, §7), więc przy okazji nie zwija. Liczników przy nazwach **nie ma** — usunięte wraz
z całym mechanizmem `updateCount`.

> **Różnica we wdrożeniu.** Produkcja ma dziewięć sekcji, bez **Accessibility**.
> Jej trzy wiersze — Tag, Role, Aria Label — to atrybuty HTML, nie CSS, i mają
> już swoje miejsce: zakładkę **Attributes** obok Styles. Trzecie miejsce na tę
> samą rzecz byłoby dwoma źródłami prawdy o jednym atrybucie. Kolejność
> pozostałych dziewięciu jest z makiety 1:1.

**Rail nie zgadza się z sekcjami** i to jest znany dług: ma 8 pozycji
(Position, Size, Layout, Typography, Background, Border, Effects, Interaction)
wobec 10 sekcji. Brakuje Spacing, Transforms i Accessibility, a `Background`
i `Border` nie istnieją już jako osobne sekcje — wsiąkły w `Styles`.

---

## 4. Katalog kontrolek

### 4.1 Pola

| kontrolka | klasa | zachowanie |
|---|---|---|
| Text | `.field` | zwykłe pole |
| NumberField | `.field.numberfield` | chevrony `.stepper` na hover/focus · przeciąganie w poziomie · Shift ×10. Wiersz daje samą matematykę kroku (`TokenAwareInput.stepValue(current, delta)`), pole niesie trzy gesty: chevron i strzałki commitują krok, **scrub jest sesją** — `Input.onScrub` podaje co klatkę sumę kroków od chwytu, pole podgląda `start + total` kanałem `onPreview` (scena reaguje natychmiast, bez zapisu do store) i commituje raz przy puszczeniu (jeden wpis undo). `UnitField` i pole Opacity mają tę samą sesję |
| Pole z osią | `.numberfield > .axis` | litera `X`/`Y` przy prawej krawędzi w spoczynku, **ustępuje stepperowi** pod kursorem — ten sam slot 16px, więc wartość nie skacze |
| DimensionField | `.fused` | numberfield ⊕ select sklejone w jeden pasek (`Width`, `Height`) |
| Select | `.field.select` | menu z `data-options`, w braku — słownik po etykiecie (§7.4) |
| StepGroup | `.duo > .stepgroup` | para −/+ obok pola, dla wartości policzalnych |
| UnitField | `.duo` | liczba ⊕ select jednostki; słowa kluczowe (`auto`, `none`, `normal`) w tym samym selekcie, więc pole potrafi TRZYMAĆ `auto`. Jeden komponent dla wierszy długości (§4.1), popoutu wartości (§6.6) i offsetów pozycji |
| PositionControl | `.trigger` → popout | `object-position` / `background-position` jako klik, nie fraza: pole-trigger (wygląd jak wiersz efektu) otwiera siatkę 3×3 kotwic (left/center/right × top/center/bottom, hover podgląda na scenie) + pola X / Y (`UnitField`, `%`/`px`/`em`/`rem`). Kafel świeci, gdy wartość rozwiązuje się do jego kotwicy — słowem albo procentem (`0% 0%` = `left top`) |

### 4.2 Grupy przycisków

| kontrolka | klasa | zachowanie |
|---|---|---|
| SegmentedControl | `.segmented` | dokładnie jedna wartość aktywna |
| ButtonGroup | `.buttongroup` | warianty `.icons` (kwadratowe) i `.fill` (rozciągnięty, z `.chipvalue` i chevronem „więcej" — §7.5) |

Tor grupy to `--border-muted` prześwitujący między klawiszami — nie ma
narysowanych kresek.

### 4.3 Suwak

`.slider > .track > .knob`. Jeden **delegowany** sterownik na całą stronę:
klik w punkt toru albo przeciągnięcie. W `.slidepair` spięty dwukierunkowo
z polem liczbowym; skala z `data-max`.

### 4.4 Próbki koloru

`.swatchrow` — `chip · nazwa · ×`. Warianty chipa: `solid`, `gradient`,
`image`, `empty`, `border-preview`. `.swatchonly` to rząd samych próbek z `+`.
Klik otwiera pływający edytor (`window.__openPopout`).

---

## 5. Kontrakt usuwania

Trzy reguły, sprawdzane w tej kolejności (`decorate()` w skrypcie panelu):

| # | wiersz | mechanizm | klik |
|---|---|---|---|
| 1 | **dodany z `+`** (w tym efekt) | `.rowx` — kreska w trzecim slocie wiersza | zdejmuje cały wiersz, bez menu i bez pytania |
| 2 | **stały, z polem lub próbką** | `.fieldx` / `.swatchrow .remove` — × **w polu**, przy prawej krawędzi | czyści wartość; wiersza nie da się zdjąć |
| 3 | **stały, z selectem** | nic | chevron zostaje nietknięty |

Zasady, które z tego wynikają:

- **Select nigdy nie oddaje chevronu za ×.** Chevron jest jedynym sygnałem, że
  kontrolka się rozwija; podmienianie go pod kursorem zabierało ten sygnał
  dokładnie wtedy, gdy użytkownik na kontrolkę patrzy.
- **Pola liczbowe nie dostają ×.** Liczbę nadpisuje się wpisując inną;
  „wyczyść" zostawiało pole puste, czyli stan, którego liczba nie ma.
  Wykrywanie: klasa `.numberfield`, obecność `.stepgroup` albo wartość, która
  parsuje się jako liczba.
- **Grupy wielopolowe** (`.trbl`, `.sides`, `.insetbox`, `.mediafield`) nie
  dostają × — jeden przycisk przy pierwszym z czterech pól nie mówi, które czyści.
- **× pokazuje się tylko, gdy jest wartość.** Steruje tym `data-set` na polu,
  trzymane w zgodzie z treścią przez `input`/`change`, a nie tylko w momencie
  czyszczenia.
- **Grupy segmentów nie dostają nic** — zawsze jedna opcja jest wciśnięta,
  więc nie mają stanu „pusty".

### Wygląd przycisków

| | rozmiar | w spoczynku | hover |
|---|---|---|---|
| `.rowx` (uchwyt wiersza) | 30 × 30, promień 8px | sama kreska, `--text-bright` (jak `+` w nagłówku) | **box**: `--bg-surface-2` + obrys `--border-muted` |
| `.fieldx`, `.swatchrow .remove`, `.efxbtn` | 22 × 22 | sam znak, `--text-subtle` | **tylko kolor** → `--text-bright` |

Box dostaje wyłącznie uchwyt wiersza — stoi na gołym tle panelu, więc nie ma
czego pod nim rozjaśnić. × siedzi w polu, a pole samo jaśnieje na hover; druga
ramka w środku ramki to dwa pudełka na jedną rzecz.

---

## 6. Wzorce złożone

### 6.1 Zakres: wspólna wartość albo per część

`.scopegroup[data-mode="all" | "parts"]` — używane przez `Radius` (4 rogi)
i docelowo `Rotate` (3 osie, `.parts[data-parts="3"]`). (Wiersz Padding w
Layout, który też na nim jeździł, wyleciał 2026-09-04 — dublował box Spacing.)

```
Radius    [ 0 ]  ← wygaszone      [▢][⛶]
          [0] [0] [0] [0]
          TL  TR  BR  BL
```

- **Pierwsza linia nie zmienia kształtu**: zawsze jedno pole + przełącznik obok.
- W trybie `parts` pole **zostaje na miejscu i gaśnie** — `disabled`
  + `pointer-events: none`, tło `--overlay-5`, stepper schowany. Wyłączone
  naprawdę, nie tylko wizualnie: nie da się w nie kliknąć, wejść tabem ani
  przeciągnąć po liczbie.
- Blok części bierze **całą szerokość kolumny kontrolki**, także miejsce pod
  przełącznikiem. Litery stoją **pod** polami — w polu konkurowałyby z wartością
  o te same 30px.
- Oba stany siedzą w markupie; przełącznik zmienia tylko `data-mode`, więc
  wpisana wartość nie znika przy przełączaniu tam i z powrotem.

### 6.2 Inset

Boks w idiomie sekcji Spacing: `.box` z fasetami `.segment--top/right/bottom/left`
(granice pasm wychodzą z różnicy wypełnień, zero narysowanych kresek) i `.sideval`
w każdym paśmie. Kursory `n/e/s/w-resize`.

W środku, na miejscu `.boxcore`, siedzi **pinbox**:

- cztery belki `.pin` ciasno wokół rdzenia (2px odstępu, nie przy krawędziach
  pasm); przypięta świeci `--accent-3`, odpięta jest `--border-strong`
- **pin blokuje krawędź**: `readOnly` na polu, wygaszony tekst, a na scenie
  podglądu zamrożona oś free-move — przypięty top/bottom mrozi pion (zero
  zapisu `top`), left/right poziom (zero zapisu `left`); obie osie przypięte →
  chwyt wraca do przeciągania-reorderu (`useCanvasFreeMoveDrag`)
- stan pinów to sesyjny stan edytora — `lockedInsetSides` w `selectionSlice`,
  zerowany przy każdej zmianie zaznaczenia. CSS nie ma gdzie zapisać „ta
  krawędź jest zablokowana", więc dokument nigdy go nie widzi.
- `.pinCore` w środku to **przycisk free-move**: świeci akcentem
  (`--accent-3`), póki żadna krawędź nie jest przypięta — element jeździ
  wtedy swobodnie po scenie z podglądem wartości na żywo — a klik zdejmuje
  wszystkie piny. Pozycji nie pokazuje; od tego jest scena.

Piny leżą nad pasmami (`z-index: 2`) — inaczej klik wpadałby w strefę
przeciągania wartości.

**Free-move aktualizuje KAŻDY zapisany bok.** Drag przepisuje wszystkie
offsety, które aktywny cel stylu faktycznie przechowuje: zapisane
`right`/`bottom` dostają lustrzaną deltę (`right -= dx`, `bottom -= dy`),
a `left`/`top` są dopisywane tylko, gdy ich oś nie ma kotwicy na przeciwnej
krawędzi. Żadna wartość insetu nie zostaje w tyle po przeciągnięciu
(`useCanvasFreeMoveDrag`).

### 6.3 Spacing

Zagnieżdżone `.box--margin` → `.boxInner` → `.box--padding` → `.boxcore`.
Każde pasmo ma własny `.sideval`. Nagłówki `MARGIN` / `PADDING` z przyciskami
„połącz strony" i „wyczyść" (`.boxHeader`, `z-index: 2` z tego samego powodu
co piny).

**Szerokość pasm bocznych podąża za wartością.** Pola już mieszczą treść
(`field-sizing: content`), ale pasmo miało sztywne `--band-x` — „1093" wylewało
się poza krawędź trapezu. Teraz każdy box ustawia `--side-chars` (liczba
znaków najszerszej WYRENDEROWANEJ wartości lewo/prawo, z draftami scrubu i
popoutu włącznie), a CSS liczy `--band-x: clamp(szerokość projektowa, znaki ×
7px + padding, 118px)` — pasmo dorasta do wartości i wraca, gdy ta maleje.
Wartości boczne są przy tym kotwiczone do ŚRODKA swojego pasma (offset =
połowa grubości pasma + transform recentrujący), a nie do krawędzi — więc
rosnące pole i rosnące pasmo zawsze spotykają się na środku, zamiast doklejać
liczbę do brzegu boxa. Ten sam mechanizm działa w wariancie inset.

Box insetu dzieli z boxem spacingu CAŁY zestaw zachowań pasm: scrub (bez
przypiętych krawędzi — pin znaczy „trzymane"), żywe drafty per krawędź
(scrub może biec na innej krawędzi niż otwarty popout), i szerokość pasma
podążającą za wartością. Wspólna logika mieszka w `sideScrub.ts`.

**Scrub na pasmach.** Kursory `n/e/s/w-resize` na segmentach nie są dekoracją:
przeciągnięcie pasma scrubuje wartość jego boku — ruch OD środka elementu
zwiększa (1 px = 1 jednostka; em/rem 0.125/px jak krok suwaka; Shift ×10).
Próg 3 px odróżnia scrub od kliku (klik nadal fokusuje pole i otwiera edytor
wartości), w trakcie gestu leci sam podgląd (scena + drafty pól), commit jest
jeden — na puszczeniu; `Escape` anuluje, a domykający klik jest połykany, żeby
nie otwierał popoutu. Pointer capture trzyma gest poza pasmem; padding ma
podłogę na 0, margines schodzi w ujemne. Logika w `sideScrub.ts`.

**Gest z canvasu odbija się w panelu na żywo.** Free-move i uchwyty resize
podglądają przez inline style w iframe (bez commitów w trakcie), więc panel
nie widziałby ruchu aż do puszczenia. Dlatego oba gesty echem (throttle 64 ms)
piszą swój bieżący patch do sesyjnego `canvasGesturePreview` w selectionSlice,
a `StyleRuleComposer` / `InlineStyleComposer` nakładają go na stored styles —
Inset, Size i każde inne pole idą za przeciąganiem, a release czyści kanał
i commit przejmuje te same liczby bez mrugnięcia.

**Podgląd na żywo na scenie.** Interakcja z bokiem — fokus pola, hover pasma,
otwarty edytor wartości (§6.6) — podświetla na zaznaczonym elemencie
odpowiadające pasmo box-modelu: **ukośnie kreskowany** pas marginesu
(pomarańcz) NA ZEWNĄTRZ border-boxa albo paddingu (zieleń) WEWNĄTRZ niego,
plus chip
z użytą wartością w px („113px"; bok zerowy nie rysuje pasa, ale chip pokazuje
„0"). W trybie połączonym świecą wszystkie cztery boki — dokładnie te, które
zapis faktycznie zmieni. Stan to sesyjne `spacingHighlight` w `selectionSlice`;
rysuje go `SpacingHighlightOverlay` (`canvas/`), mierząc `getComputedStyle`
i rect elementu w pętli rAF aktywnej wyłącznie podczas interakcji — podglądy
(pisanie, suwak, hover tokenu) odświeżają pasy co klatkę, a poza interakcją
nakładka nie kosztuje nic.

**Pin „pokaż wszystkie odstępy".** Sekcja Spacing nie ma `+` (do box-modelu
nie ma czego dodać), więc jej slot akcji w nagłówku sekcji zajmuje oko
(`SpacingOverlayToggle`, `aria-pressed`) — tam, gdzie każda inna sekcja trzyma
swój jeden przycisk. Włączone trzyma na scenie WSZYSTKIE pasy marginesu i paddingu
zaznaczonego elementu, niezależnie od tego, który bok jest edytowany — box
model elementu do odczytania jednym spojrzeniem. Bok zerowy nie rysuje pasa
ani chipa (osiem „0" to szum); chip „0" zostaje tylko na boku aktualnie
edytowanym. Stan to sesyjne `spacingOverlayPinned` w `selectionSlice` —
świadomie **przeżywa zmianę zaznaczenia**, bo jest sposobem patrzenia na
elementy, nie edycją jednego z nich. Ten sam `SpacingHighlightOverlay` rysuje
oba tryby: pin daje osiem celów (box × bok), interakcja — jej boki.

Pasy rysuje `repeating-linear-gradient` pod 135°: `--canvas-spacing-*-fill`
to kreska, `--canvas-spacing-*-wash` to słabe tło między kreskami. Kreskowanie
czyta się jako „to jest przestrzeń, nie treść" także nad zdjęciem, a przerwy
zostawiają element pod spodem widoczny. Pasy żyją w przestrzeni pikseli
ekranowych (portal poza warstwą transformacji), więc podziałka kreskowania jest
stała na każdym zoomie.

**Margines ujemny też się rysuje** — ale odbity na wewnętrzną stronę tej samej
krawędzi (bo tyle miejsca element zabrał, przesuwając się w tył) i we własnym
fiolecie (`--canvas-spacing-negative-*`), żeby „ściągnięte o 20px" nigdy nie
wyglądało jak „odsunięte o 20px". Chip pokazuje wartość ze znakiem.

### 6.4 Pole obrazu

```
Image   [ Library | URL ]
        [ikona]  Kliknij, żeby dodać obraz
```

- **Zakładki `Library` / `URL`** zostają widoczne zawsze, także po wybraniu
  pliku — mówią, *skąd* obraz pochodzi, a to nie przestaje być prawdą.
  Steruje nimi `data-source`, niezależnie od `data-state`.
- **Stan pusty i kafel z plikiem mają tę samą wysokość (44px)** i tę samą
  anatomię: znak w ramce 44 × 34, nad spodem stan, pod nim akcja. Wybranie
  obrazu nie przesuwa wierszy pod spodem.
- **Kafel** pokazuje prawdziwą miniaturę (`blob:`), nazwę z tooltipem
  i `typ · rozmiar · szerokość × wysokość`. Wymiary dopisują się po wczytaniu,
  zamiast blokować wiersz do tego czasu.
- **Klik w kafel** podmienia plik. **`×` w kaflu** czyści obraz i zostawia
  wiersz — wiersz nie ma uchwytu `—`, zachowuje się jak `Fill` czy `Border`.
- `objectURL` jest zwalniany przy czyszczeniu i podmianie.

### 6.5 Effects

Efekt jest **zwykłym wierszem panelu** — układ niesie siatka `.row`, nie własna
reguła sekcji:

```
Background blur   [ ◌  4px            👁 ]   —
Inner shadow      [ ▨  0 4 · 4px      👁 ]   —
● Blend           [ Multiply            ⌄ ]  —
```

| slot | co tam stoi |
|---|---|
| kolumna etykiety | nazwa efektu (`Background blur`), zwykły `.label` |
| kolumna kontrolki | **`.efxmain` — przycisk, który JEST polem** (dziedziczy `.field`) |
| w polu, od lewej | ikona typu 13px · wartość wiodąca · oko przy prawej krawędzi |
| trzeci slot wiersza | `.rowx` — kreska, jak każdy wiersz `data-added` |

- **Ikona typu** (`.ico`, 13px, `--text-muted`) mówi, jakiego rodzaju jest
  efekt: `shadow` (kwadrat z cieniem), `blur` (okrąg kreskowany), `grain`
  (ziarno). Trzy ikony na sześć efektów — cień i cień wewnętrzny dzielą jedną,
  oba rozmycia i Glass też.
- **Wartość wiodąca** (`.val`) to skrót parametrów, nie pole do wpisywania:
  `4px` (rozmycia), `0 4 · 4px` (cienie: przesunięcia · rozmycie), `4 × 4`
  (Texture), `80%` (Glass). Zjada nadmiar wielokropkiem.
- **Oko siedzi W POLU**, w tym samym slocie i rozmiarze co `.fieldx`
  (22 × 22, hover zmienia tylko kolor) — bo jest akcją **na wartości**.
  Na wierszu działa wyłącznie kreska w trzecim slocie.
- **Ukryty efekt gaśnie cały**: `data-hidden="true"` na wierszu wygasza
  etykietę, pole i oko do `--text-disabled`, a ikona oka zmienia się na
  przekreśloną. Wiersz zostaje na miejscu — to jest różnica między „wyłącz"
  a „usuń".
- **Klik w pole otwiera popout**; klik w oko go nie otwiera (zdarzenie się
  zatrzymuje). Otwarty popout znaczy wiersz `aria-expanded="true"`, co maluje
  **obrys pola** i **ikonę** na `--accent-3`.
- Lista efektów (`.efxlist`, odstęp `--control-row-gap`) wchodzi na **początek**
  sekcji; `Blend` zostaje pod nią jako zwykły wiersz z selectem.

**Popout efektu** to ten sam `.popout` co reszta panelu: 244px, nagłówek
z nazwą efektu i krzyżykiem, wiersze w wariancie `narrow` (etykieta 52px).
Otwiera się **na lewo od wiersza** (`left − szerokość − 10`), a gdy tam nie ma
miejsca — na prawo; w pionie przycięty do okna. Każdy typ wnosi własny zestaw
pól i to jest cała różnica między efektami:

| efekt | ikona | wartość | popout |
|---|---|---|---|
| Drop shadow | `shadow` | `0 4 · 4px` | Position (para x/y) · Blur · Spread · Color (próbka + %) |
| Inner shadow | `shadow` | `0 4 · 4px` | to samo co wyżej |
| Layer blur | `blur` | `4px` | Blur |
| Background blur | `blur` | `4px` | Mode (Uniform / Progressive) · Blur |
| Texture | `grain` | `4 × 4` | Size (para x/y) · Radius |
| Glass | `blur` | `80%` | Refraction · Depth · Dispersion · Frost — cztery suwaki |

> **Pułapka makiety.** Nad `ROW_X` w bloku efektów stoi komentarz „Krzyżyk, nie
> kreska". Jest **nieaktualny**: `makeRow` woła wspólny `__decorateRow`, więc
> efekt dostaje tę samą kreskę co każdy inny wiersz `data-added` — i tak
> wygląda w przeglądarce. Komentarz został po wersji, w której efekty miały
> własny przycisk.

> **Różnica we wdrożeniu.** Produkcja świadomie **nie ma oka** (decyzja autora,
> 2026-08-28): CSS nie zna wyłączonego cienia, więc „ukryty efekt" nie miałby
> gdzie mieszkać bez nowego klucza w modelu stylów. Wiersz ma samą kreskę.
> Wdrażane są cztery efekty z czystym odpowiednikiem w CSS — Drop shadow
> i Inner shadow nad listą `box-shadow`, Layer blur nad `filter: blur()`,
> Background blur nad `backdrop-filter: blur()`. Texture i Glass zostają
> w makiecie: żaden z nich nie jest jedną właściwością CSS.

> **Powłoka popoutu we wdrożeniu.** Produkcyjny `.popout` to
> `FloatingPanel` (`src/ui/components/FloatingPanel`) — jedna powłoka dla
> pickera koloru, popoutu bordera i parametrów efektu. Jej zachowanie:
>
> - **Zawsze w całości na ekranie.** Pierwsze ustawienie klampuje z
>   szacowanej wysokości (panel nie jest jeszcze w DOM); zaraz po
>   zamontowaniu pozycja jest doklampowana z realnego pomiaru, a
>   `ResizeObserver` na panelu + nasłuch `resize` okna doklampowują ją przy
>   każdej zmianie rozmiaru treści (np. wjeździe pickera koloru) i okna —
>   z dala od krawędzi i od pasków oznaczonych `data-floating-obstacle`.
> - **Jeden panel naraz — nawigacja zamiast stosu** (decyzja autora,
>   2026-08-30): pole koloru wewnątrz popoutu bordera / efektu nie otwiera
>   drugiego panelu, tylko **wsuwa widok pickera w ten sam panel**
>   (`FloatingPanelDrillView`): nagłówek dostaje strzałkę wstecz i
>   kontekstowy tytuł („Border color", „Shadow color"), × dalej zamyka cały
>   panel, Escape najpierw cofa z wsuniętego widoku. Widok główny zostaje
>   zamontowany pod spodem, więc jego stan (aktywna krawędź, niedokończone
>   pole) przeżywa podróż tam i z powrotem. `ColorInput` włącza ten tryb
>   propem `drillInTitle`; poza panelem swatch otwiera własny panel jak
>   dotąd.
> - **Menu nie zamykają panelu.** Pointerdown w rozwijaną listę selecta lub
>   menu (`[role="listbox"]` / `[role="menu"]` portalowane PO panelu w
>   porządku dokumentu) nie liczy się jako „klik poza".

### 6.6 Edytor wartości (popout)

Fokus w polu boku Spacingu (§6.3) lub Insetu (§6.2) otwiera **pływający edytor
wartości** — `ValueEditorPopout` na wspólnym `FloatingPanel`, obok pola. Jeden
naraz: fokus na innym boku przenosi go tam, Escape / klik obok zamyka. Od góry:

- **suwak + `UnitField`** — ten sam duet liczba ⊕ select jednostki, którym
  jedzie każdy wiersz długości (§4.1), na proporcjach popoutu (44 ⊕ 52 px;
  `px` domyślnie, `em`, `rem`, `%`, `vw`, `vh`). Tam, gdzie właściwość zna
  `auto` (margin, inset), słowo kluczowe siedzi **w selekcie** — pole potrafi
  TRZYMAĆ `auto` (pole wygaszone, select „Auto"), zamiast świecić pustką obok
  chipa. Zakres suwaka zależy od jednostki (px 0–512, em/rem 0–16, % 0–100);
  inset schodzi w ujemne. Zmiana jednostki **nie przelicza** —
  przeetykietowuje liczbę (`16px` → `16em`); jednostka wybrana przy pustym
  polu (`onUnitChange`) od razu przestawia suwak i presety.
- **siatka chipów** w czterech kolumnach: `Auto` (margin i inset — padding nie
  zna auto) to **kwadrat 2×2** — słowo kluczowe, nie liczba, i kształt mówi
  to od razu; obok osiem presetów px w dwóch pełnych rzędach (em/rem: 0…8).
  Klik commit-uje od razu, hover podgląda.
- **siatka tokenów** — cała skala spacingu frameworka (`4xs`…`4xl`) jako te
  same chipy; klik zapisuje `var(--space-…)`. Dlatego pola boków **nie**
  otwierają już własnego dropdownu z podpowiedziami: skala mieszka tutaj, a
  druga pływająca lista obok tego samego pola zasłaniałaby scenę. Pole nadal
  rozwiązuje wpisany krok (`m` → `var(--space-m)`) i pokazuje token skrótem.
- **stopka Reset** — przycisk na pełną szerokość, opis pod nim; czyści bok do
  „nieustawione" tą samą ścieżką co wyczyszczenie pola inline.

Edytor **nie ma własnego kanału zapisu**: wszystko idzie przez onCommit /
onPreview boku, więc tryb linked rozchodzi się na cztery strony jak przy
wpisywaniu, a undo dostaje jeden krok na puszczenie suwaka / klik chipa.
Suwak marginesu i insetu schodzi w **ujemne** (`-512…512` px) — marginy się
zwijają, offsety insetu ciągną element poza krawędź. Padding zostaje na zerze:
ujemny padding to niepoprawny CSS, nie decyzja produktowa.

Wartość, której nie da się sparsować na liczbę + jednostkę (`calc(...)`),
pokazuje stan „complex value": suwak, liczba i presety gasną, a jednostka,
siatka tokenów i Reset zostają — token JEST wartością do wybrania tutaj, więc
nie może zablokować edytora, który go ustawił. Przypięty bok insetu edytora
nie otwiera.

Popout podgląda na żywo: każdy ruch suwaka i hover chipa leci przez
`onPreview`, a pola boków (oraz pole liczbowe w samym popoucie) pokazują ten
draft od razu — commit na puszczeniu suwaka tylko go utrwala. Dzięki temu
liczby idą w parze z tym, co widać na scenie, zamiast doskakiwać po fakcie.

Pole boku zostaje **sfokusowane**, kiedy popout pisze — więc `TokenAwareInput`
przyjmuje zewnętrzną wartość zawsze, gdy użytkownik nie jest w trakcie
wpisywania (sam fokus jej nie blokuje). Bez tego draft pola zostawałby na
wartości sprzed popoutu i najbliższy blur zapisywałby ją z powrotem, kasując
to, co ustawił suwak albo chip. Suwak łapie `setPointerCapture` na
`pointerdown`, żeby puszczenie przycisku poza torem też trafiło w commit —
inaczej przeciągnięcie zostawałoby samym podglądem.

---

## 7. Menu

Cztery menu, jedna warstwa. Każde renderuje się do `#menulayer`
(`position: fixed; inset: 0; pointer-events: none; z-index: 70`; dzieci
dostają `position: absolute` i `pointer-events: auto`), więc żadne nie
przycina się do scrollera panelu.

| trigger | menu | co dodaje / zmienia |
|---|---|---|
| `+` w nagłówku sekcji | `.propmenu` — wyszukiwarka + lista | **nowy wiersz** właściwości w tej sekcji |
| `+` w nagłówku **Effects** | `.selectmenu` — sama lista | **nowy efekt** na liście efektów |
| `.field.select` | `.selectmenu` | wartość pola |
| chevron „więcej" w `.buttongroup[data-more]` | `.selectmenu` | wartość grupy, także spoza segmentów |

Menu jest **zakotwiczone w punkcie, nie w elemencie**. Dlatego każde zamyka
się na trzy sposoby: `pointerdown` poza sobą, `Escape` i **`scroll` w fazie
capture** — przewinięcie zostawiłoby je wiszące w powietrzu.

### 7.1 `.propmenu` — menu „+"

```
┌ 216px ──────────────────────┐
│ 🔍 Type to search…      30px│  ← border-bottom --border-muted
├─────────────────────────────┤
│ Direction                   │  ← .item, 26px, radius --radius-sm
│ Wrap                    ✓   │  ← data-used: wygaszona, ptaszek --accent-3
│ Filters                 ›   │  ← kind: submenu, chevron obrócony o -90°
└─────────────────────────────┘     .list: max-height 244px, własny scroll
```

- **Wyszukiwarka dostaje fokus od razu.** Filtr to zwykłe `includes` po nazwie,
  bez rozróżniania wielkości liter. Gdy nic nie pasuje, lista pokazuje jeden
  wiersz `Nic nie pasuje`.
- **`Enter` bierze pierwszą pozycję**, która nie jest `data-used` — nie trzeba
  schodzić do listy myszą.
- **Właściwość już obecna w sekcji jest wygaszona.** Zbiór „użytych" powstaje
  przy każdym otwarciu z etykiet wierszy w `.sec-body`, więc nie ma osobnego
  stanu do rozjechania. Wygaszona pozycja niesie ptaszek, `cursor: default`
  i nie reaguje na hover ani na klik.
- Tło menu to ton triggera (`--bg-surface-2`), tak samo jak w `.selectmenu` —
  menu jest rozwiniętym triggerem, nie osobną kartą.

### 7.2 Katalog

Treść menu bierze się z `CATALOG` — jedna lista na sekcję, dobierana po nazwie
sekcji z nagłówka. Sekcja bez wpisu dostaje menu puste.

| sekcja | pozycje |
|---|---|
| Layout | Direction · Wrap · Distribute · Row Gap · Column Gap · Auto Flow |
| Position | Float · Clear · Isolation |
| Size | Min/Max Width · Min/Max Height · Aspect Ratio |
| Spacing | Margin · Scroll Margin · Scroll Padding |
| Styles | Background Image · Background Size · Background Position · Outline · Mix Blend Mode |
| Typography | Transform · Decoration · White Space · Text Overflow · Font Style |
| Effects | Hover · Press · **Filters ›** · Backdrop Blur · Shadows · Transition |
| Transforms | Translate · Skew · Perspective |
| Interaction | Pointer Events · User Select · Touch Action · Scroll Behavior |
| Accessibility | Tag · Role · Aria Label |

Każda pozycja niesie `kind`, który decyduje, jaką kontrolkę dostanie nowy
wiersz: `number` → NumberField ze stepperem · `text` → pole tekstowe
· `select` → select z `data-options` z tej samej pozycji · `segmented`
→ grupa segmentów z pierwszą opcją wciśniętą · `dimension` → `.fused`
(numberfield ⊕ select trybu) · `effect` → chip efektu otwierający popout
· `swatch` → `.swatchrow` w stanie pustym.

Wiersz dodany z menu dostaje **`data-added="true"`**, czyli regułę 1 kontraktu
usuwania (§5): uchwyt `.rowx` przy krawędzi, jeden klik zdejmuje wiersz.
Po dodaniu fokus wchodzi w świeżą kontrolkę.

### 7.3 Podmenu (flyout)

Pozycja `kind: 'submenu'` otwiera **`.propmenu.flyout`** — tę samą listę bez
wyszukiwarki, 176px:

- otwiera się **na hover i na klik**; rodzic zostaje widoczny, więc oba poziomy
  są na oczach naraz,
- **preferuje lewą stronę** rodzica (`x = menu.left − szerokość − 4`); dopiero
  gdy tam brakuje miejsca, wychodzi w prawo — menu i tak siedzi przy prawej
  krawędzi okna,
- staje **na wysokości pozycji, która je otworzyła**, przycięte do 8px od
  krawędzi okna,
- pozycja-rodzic świeci `data-flyout-open`, a najechanie na dowolną **zwykłą**
  pozycję chowa flyout sąsiada,
- dzieci dziedziczą wygaszanie użytych i wstawiają wiersz przez tę samą
  ścieżkę co pozycje pierwszego poziomu; wybór zamyka **całe** menu.

Jedyna pozycja `submenu` w katalogu to `Filters` w sekcji Effects, a `+` tej
sekcji jest przejęte (§7.6) — w żywym panelu flyout nie ma dziś jak się
otworzyć. Mechanizm jest zbudowany i przetestowany na katalogu, ale ścieżka
do niego jest przerwana; patrz §11.

### 7.4 `.selectmenu` — menu selecta

- Lista bierze się z `data-options` na polu (`|` jako separator). W jego braku
  — ze słownika po **etykiecie wiersza** (`Overflow`, `Distribute`, `Blend`,
  `Font`, `Weight`, `Origin`, `Style`, `Cursor`, `Touch Action`, `Height`),
  a `Type` w sekcji Position dostaje własny zestaw pozycjonowania.
- Select trybu wymiaru nie ma etykiety, po której dałoby się go poznać, więc
  rozpoznaje się go **po bieżącej wartości**: `Fixed / Relative / Fill / Fit
  Content` albo skrócone `Rel / Min / Max`. Gdy i to nie zadziała, lista ma
  jedną pozycję — tę już wybraną.
- Menu staje **pod polem, o tej samej minimalnej szerokości**, i odbija się nad
  pole, gdy nie mieści się do dołu ekranu.
- Bieżąca opcja niesie `aria-selected` i ptaszek `--accent-3`, sam tekst
  jaśnieje do `--text-bright`.
- Otwarte pole zmienia się widocznie: tło `--bg-surface-3`, obrys
  `--overlay-30`, chevron obrócony o 180° (przejście 120ms).
- Ponowny klik w to samo pole zamyka menu.

### 7.5 Menu „więcej" w ButtonGroup

Grupa z atrybutem `data-more` chowa za chevronem wartości, które nie zmieściły
się jako segmenty. Menu pokazuje **segmenty i resztę w jednej liście**
(min. 140px albo szerokość grupy), z ptaszkiem przy bieżącej wartości.

Wybór zmienia kształt kontrolki: wartość będąca segmentem po prostu go wciska,
a wartość spoza segmentów przełącza grupę w **`data-chip`** — wszystkie
segmenty gasną, a wybrana wartość ląduje w `.chipvalue` obok chevronu.

### 7.6 `+` w sekcji Effects

Nagłówek Effects przejmuje własne `+` **w fazie capture** i zatrzymuje
zdarzenie, więc `.propmenu` w tej sekcji nigdy się nie otwiera. Zamiast niego
wychodzi `.selectmenu` (min. 170px, przy prawej krawędzi przycisku) — lista bez
wyszukiwarki, z **pełnym i jedynym** katalogiem efektów, w tej kolejności:

```
Drop shadow
Inner shadow
Layer blur
Background blur
Texture
Glass
```

Efekty już obecne na liście są wygaszone `data-used`, tak samo jak właściwości
w menu „+". Nazwa jest kluczem katalogu — ona niesie ikonę, wartość wiodącą
i zestaw pól popoutu (§6.5).

Wybrany efekt dokłada wiersz przez `makeRow`, a ten przechodzi przez ten sam
`decorate` co reszta panelu, więc dostaje `.rowx` i regułę 1 — efekt nie ma
własnego przycisku usuwania.

### 7.7 Pozycjonowanie

| menu | kotwica | odstęp | zachowanie przy krawędzi |
|---|---|---|---|
| `.propmenu` | prawa krawędź `+` | 6px pod | odbija **nad** trigger; nigdy bliżej niż 8px od krawędzi okna |
| flyout | lewa krawędź rodzica | 4px obok | wychodzi w prawo, gdy z lewej brak miejsca; pion przycięty do okna |
| select | lewa krawędź pola | 4px pod | odbija nad pole; przesuwa się w lewo, gdy nie mieści się w oknie |
| buttongroup | lewa krawędź grupy | 4px pod | jak wyżej |
| Effects | prawa krawędź `+` | 6px pod | tylko przycięcie w poziomie |

> **Różnica we wdrożeniu.** W makiecie każde menu **zamyka się** na scroll, bo
> jest zakotwiczone w punkcie i inaczej zawisłoby w powietrzu. Produkcyjny
> `ContextMenu` mierzy kotwicę i **jedzie za nią** (nasłuch scrolla w fazie
> capture + `ResizeObserver`), więc menu otwarte nad przewijaną sekcją zostaje
> otwarte. To celowo lepsze zachowanie, nie rozjazd — makieta nie miała czym
> śledzić kotwicy.

---

## 8. Zachowania delegowane

Sterowniki wpięte **na dokumencie**, więc działają dla każdej instancji —
także dla wierszy dokładanych później:

`segmented` · `buttongroup` · `fillmodes` · stepper w polu · `stepgroup` −/+ ·
przeciąganie po liczbie · `select` → menu · `slider` · klamra proporcji ·
piny insetu · przełącznik zakresu · zwijanie sekcji.

Per element zostają tylko rzeczy z własnym stanem: tory hue/alpha w colorpickerze
i splitter.

> **Pułapka tego pliku.** Skrypt panelu to jeden wielki IIFE, a `readNum`
> i `writeNum` są `const`. Każdy kod dopisany **powyżej** nich, który wykonuje
> się od razu, wywala TDZ i **ubija resztę skryptu** — łącznie z tym, co już
> działało. Wstawki na początku IIFE nie mogą sięgać po stałe z dołu.

---

## 9. Reakcja na szerokość

Szerokie kontrolki — `.spacebox`, `.insetbox`, `.mediafield` — **zawijają się,
zamiast się ściskać**:

1. **rosną** z kolumną kontrolki
2. gdy nie mieszczą się obok etykiety w swojej progowej szerokości
   (`flex-basis`: 220px dla boksów, 200px dla pola obrazu), **schodzą pod nią**
   i biorą całą szerokość sekcji
3. dopiero gdy i to nie starczy, **kurczą się** — zawsze w granicach panelu

Wiersz jest wtedy flexem z `flex-wrap`, bo siatka umie tylko ściskać kolumnę —
nie umie przenieść jej niżej.

Zmierzone przy `--panel-w`:

| dok | Spacing / Inset | Image |
|---|---|---|
| 560 | 386, z lewej | 386, z lewej |
| 460 | 286, z lewej | 286, z lewej |
| 380 | **314, nad** | 206, z lewej |
| 304 *(min)* | **238, nad** | **238, nad** |

---

## 10. Kolory

Drabina zakotwiczona w chrome `#0d0d0e`. Każdy stopień trzyma dystans w `L*`,
pod jaki był projektowany, gdy panel był jeszcze kartą `#1b1b1b`.

| token | wartość | ΔL* do podłoża | co maluje |
|---|---|---|---|
| `--bg-body` | `#0d0d0e` | — | chrome: podłoże panelu, railu i popoutu |
| `--bg-surface-2` | `#1b1b1b` | +6,4 | wypełnienie pola, selecta, toru segmentów · **tło menu** |
| `--bg-surface-3` | `#252525` | +11,0 | to samo na hover |
| `--bg-surface-4` | `#3c3c3c` | +21,7 | wciśnięty klawisz · tor slidera · kciuk scrollbara |
| `--border-subtle` | `#121212` | +2,0 | kreski między sekcjami |
| `--border-muted` | `#212121` | +9,2 | obrys popoutu i menu · hairline w grupach |

**`--bg-surface` nie istnieje.** Znaczył „kartę panelu"; panel kartą nie jest,
a jego ostatni użytkownik (`.popout`) stoi na tonie chrome.

**Wdrożenie: dwie drabinki, jeden przełącznik.** `globals.css` trzyma drabinkę
kart (`--card-surface-2/3/4`, `--card-line-subtle/muted`) i drabinkę chrome
(`--panel-surface-*`, `--panel-line-*`); żywe `--bg-surface-2/3/4` i
`--border-subtle/muted` są aliasami tej, którą wybrał najbliższy
`[data-surface]`. Powłoki stojące na `--bg-body` — oba sidebary, toolbar i
`FloatingPanel` (portal do `<body>`, więc musi sam się ostemplować) — mają
`data-surface="chrome"`; karta `--bg-surface` z polami wewnątrz takiej powłoki
(Agent, pływający wariant panelu, karta koloru, lista kroków skali) ma
`data-surface="card"` i dostaje z powrotem jaśniejszą drabinkę. Reszta admina
nie potrzebuje stempla — korzeń i tak rozwiązuje się do kart. Dzięki temu
`Input`, `Select`, `SearchBar`, `SegmentedControl` czy `StepGroup` wyglądają
identycznie po lewej i po prawej stronie edytora bez żadnego nadpisania per
komponent, a popout ma te same tony co panel, z którego odpłynął.

**Jeden akcent: `--accent-3` = `#0099ff`.** Kropka „właściwość ustawiona",
kropka klasy, ptaszek w menu, przypięta krawędź insetu, wciśnięty przełącznik,
rozwinięty efekt. `--accent-1` i `--accent-2` skasowane — kolor jest sygnałem
stanu, a trzy sygnały to żaden sygnał.

Tekst: `--text-bright` `#f4f4f5` (tytuł, wartość, ikona aktywna) ·
`--text` `#ededed` (treść pola) · `--text-muted` `#a1a1aa` (etykieta wiersza) ·
`--text-subtle` `#787878` (ikona railu, jednostka, caret) ·
`--text-disabled` `#52525b` (placeholder, litery osi).

**Menu (`.selectmenu`, `.propmenu`) siedzi na tonie triggera** (`--bg-surface-2`),
nie na tonie karty — menu jest rozwiniętym triggerem. `.popout` siedzi na tonie
panelu, bo jest kawałkiem panelu, który odpłynął. Unoszą go obrys i cień.

---

## 11. Znane rozjazdy

| co | stan |
|---|---|
| rail vs sekcje | 8 ikon na 10 sekcji; brak Spacing, Transforms, Accessibility; zbędne Background i Border |
| stały select | nie ma jak wyczyścić wartości, dopóki jego lista nie dostanie pozycji „Default" |
| grupy segmentów | `Type`, `Align` ×2, `Visible` nie mają stanu „pusty", więc nie mają czym być przywrócone do domyślnej |
| `.numberfield` | marker niekonsekwentny: `Gap`, `Size`, `Spacing`, `Scale` są polami liczbowymi bez tej klasy — reguły muszą to obchodzić, patrząc też na `.stepgroup` i na wartość |
| `Inset` vs `Padding` | litery: `Inset` ma je **w polach** (fasety boksu), `Padding` **pod polami** (blok części) |
| `+` znaczy dwie rzeczy | w dziewięciu sekcjach otwiera `.propmenu` z wyszukiwarką, w Effects — katalog efektów (§7.6). Oba menu są zaprojektowane i chciane; rozjazdem jest to, że **wyglądają identycznie**, a jedno dodaje właściwość CSS, drugie efekt |
| flyout bez wejścia | jedyne `submenu` (`Filters`) siedzi w katalogu Effects, którego `+` jest przejęte — podmenu jest nieosiągalne z panelu |
| martwy wiersz `Filters` | jest w statycznym markupie Effects razem z własnym menu (`data-add="filters"`), ale montaż listy efektów kasuje wszystkie wiersze poza `Blend` |
| cztery implementacje menu | `.propmenu`, select, buttongroup „więcej" i katalog efektów mają osobny stan otwarcia — jedno menu nie zamyka drugiego, choć wszystkie żyją w `#menulayer` |
| makieta poza repo | `.tmp/` jest w `.gitignore` — prototyp nie ma historii i nie da się cofnąć do poprzedniej wersji |
