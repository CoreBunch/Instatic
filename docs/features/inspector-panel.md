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

---

## 3. Sekcje

Kolejność w panelu:

| # | sekcja | wiersze |
|---|---|---|
| 1 | **Position** | Type · Inset · Z Index |
| 2 | **Size** | Width · Height |
| 3 | **Layout** | Type · Columns · Rows · Align · Gap · Padding |
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
| NumberField | `.field.numberfield` | chevrony `.stepper` na hover/focus · przeciąganie w poziomie · Shift ×10 |
| Pole z osią | `.numberfield > .axis` | litera `X`/`Y` przy prawej krawędzi w spoczynku, **ustępuje stepperowi** pod kursorem — ten sam slot 16px, więc wartość nie skacze |
| DimensionField | `.fused` | numberfield ⊕ select sklejone w jeden pasek (`Width`, `Height`) |
| Select | `.field.select` | menu z `data-options`, w braku — słownik po etykiecie (§7.4) |
| StepGroup | `.duo > .stepgroup` | para −/+ obok pola, dla wartości policzalnych |

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

`.scopegroup[data-mode="all" | "parts"]` — używane przez `Padding` (4 strony),
`Radius` (4 rogi) i `Rotate` (3 osie, `.parts[data-parts="3"]`).

```
Padding   [ 0 ]  ← wygaszone      [▢][⛶]
          [0] [0] [0] [0]
           T   R   B   L
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

- cztery belki `.pin` przy krawędziach; przypięta świeci `--accent-3`,
  odpięta jest `--border-strong`
- **pin blokuje krawędź**: `readOnly` na polu, pominięcie przy przeciąganiu
  elementu na scenie podglądu, wygaszony tekst
- `.core` w środku to **czysta wizualizacja** — nie przeciąga się i nie jedzie
  za wartościami. Pozycję pokazuje scena, nie miniaturka w panelu.

Piny leżą nad pasmami (`z-index: 2`) — inaczej klik wpadałby w strefę
przeciągania wartości.

### 6.3 Spacing

Zagnieżdżone `.box--margin` → `.boxInner` → `.box--padding` → `.boxcore`.
Każde pasmo ma własny `.sideval`. Nagłówki `MARGIN` / `PADDING` z przyciskami
„połącz strony" i „wyczyść" (`.boxHeader`, `z-index: 2` z tego samego powodu
co piny).

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
