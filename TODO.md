# TODO — fork 0x6Star3s/Instatic

Lista robocza tego forka. Nie jest przeznaczona do PR-a do oryginału.

## Układ repozytorium

- `origin` → https://github.com/0x6Star3s/Instatic.git — Twój fork, tutaj wypychasz
- `upstream` → https://github.com/CoreBunch/Instatic — oryginał, stąd tylko pobierasz

Aktualizacja z oryginału: `git fetch upstream`, potem `git rebase upstream/main`.

## Zrobione

- [x] Fork podpięty jako `origin`, oryginał jako `upstream`
- [x] `main` podciągnięty do najnowszego stanu oryginału (`a0b1e4e5`, +10 commitów)
- [x] Cała praca wyciągnięta z dysku do forka (nic nie wisi już niezacommitowane)
- [x] Skonsolidowane na `main`:
      icon packs + IconPicker, warianty Visual Components + sekcja Variants
      w Properties Panel, media crop z focus area + import z Unsplash
- [x] `bun run build` przechodzi
- [x] `bun run lint` przechodzi

## Do zrobienia

### 1. Nowy color picker
Zlecone subagentowi. Zakres: kwadrat nasycenia, suwak barwy, suwak alfy,
pole hex + procent, przełącznik HEX/RGB/HSL, eyedropper (natywne
`EyeDropper` API), wyszukiwarka tokenów, akcja "New Style".

### 2. Rozbić commit-migawkę
`7c476376` miesza pięć niezwiązanych wątków (ikony, warianty, ImageViewer,
sanityzacja SVG, baza). Trzeba rozdzielić na tematyczne commity — konieczne,
jeśli cokolwiek ma iść jako PR do oryginału.

### 3. Triage 88 failujących testów
Build i lint są zielone, ale `bun test` daje 88 porażek na 6743 testy.
**Baseline nieustalony** — porównanie z czystym upstreamem nie dokończyło
się w limicie czasu, więc nie wiadomo jeszcze, które z tych porażek są nasze,
a które były w oryginale.

Podejrzenia do potwierdzenia:

| Grupa | Ile | Hipoteza |
|---|---|---|
| symlink swap, artefakty na dysku, Layer A | ~25 | **POTWIERDZONE** — ograniczenie Windows, nie nasze scalenie |
| plugin scheduler — DB | 9 | konfiguracja Postgresa w testach |
| post-type built-in fields | 13 | do zbadania |
| generated plugin bootstrap | 1 | wymaga `bun run bootstrap:sync` |
| panele, a11y, Toolbar | ~10 | do zbadania |

Metoda: uruchomić wyłącznie te pliki testowe na commicie `a0b1e4e5`
(czysty upstream) i porównać listy — pełny przebieg trwa za długo.

### 4. Rozmiar repo — paczki ikon
`src/ui/icons/packs/` to 16 MB wygenerowanego kodu, teraz na stałe w historii
gita. Rozważyć generowanie przy buildzie (`bun run icons:manifest`,
`scripts/build-icon-manifest.ts`) zamiast trzymania w repo.

### 5. Nazwa projektu
Decyzja odłożona. Rekomendacja: zmienić tylko markę widoczną dla użytkownika
(`<title>`, README, teksty w UI), a `instatic` zostawić jako identyfikator
techniczny w ścieżkach `/_instatic/...`, znaczniku `<instatic-hole>`, nazwie
paczki i obrazach Dockera. Pełny rename to 1825 wystąpień w 416 plikach i
zamienia każdą przyszłą aktualizację z upstreamu w ręczne rozwiązywanie
konfliktów.

Odrzucone nazwy: **Kiln** i **Clay** (istniejący CMS Clay + edytor
`clay-kiln`), **Imprint** (w UE to nazwa strony z notą prawną),
**Vellum** (zajęte przez firmę AI).

## Pułapki środowiskowe

**Po scaleniu gałęzi dodającej ikony do `vendor/pixel-art-icons` uruchom
`bun install`.** `node_modules/pixel-art-icons` to KOPIA, nie dowiązanie —
nowe ikony nie docierają i `tsc` wywala się na "Cannot find module
'pixel-art-icons/icons/...'". Tak właśnie wysypał się build po scaleniu
gałęzi media.

## Potwierdzone ustalenia z walidacji

### Symlinki na Windows — ~25 porazek, NIE z naszego scalenia

Sprawdzone eksperymentalnie na tej maszynie:

- `fs.symlink(target, path, 'dir')` — **FAIL, `EPERM`**
- `fs.symlink(target, path, 'junction')` — **OK**

Tworzenie symlinku katalogu na Windows wymaga trybu dewelopera albo
uprawnien administratora. Junction dziala bez zadnych uprawnien.

Publisher w `server/publish/staticArtefact.ts:287` wola:

    await symlink(targetSlot, tmpPath)

bez trzeciego argumentu z typem. Plik ma juz obsluge Windows przy `rename`
(linia 299) i `unlink` (linia 322), ale **nie przy tworzeniu** dowiazania.

To blad w kodzie oryginalu, nie skutek scalenia — te testy wywalilyby sie
tak samo na czystym upstreamie na tej maszynie.

**Proponowana poprawka:** przekazac `'junction'` na `win32`. Dwuslotowy swap
`current -> a | b` dziala z junction tak samo, bo cel jest zawsze katalogiem
i zawsze lokalny. To dobry kandydat na PR z powrotem do oryginalu.

**Obejscie natychmiastowe:** wlaczyc tryb dewelopera w Windows
(Ustawienia → Prywatnosc i zabezpieczenia → Dla deweloperow).

### Czego jeszcze nie wiadomo

Baseline dla pozostalych ~63 porazek nadal nieustalony. Warstwa DB **byla**
ruszana przez scalenie (`server/db/client.ts` dostal `close()`, doszly dwie
migracje dla media, zmienil sie `createTestDb.ts`), wiec porazek
`plugin scheduler — DB` i `post-type built-in fields` nie da sie z gory
odpisac jako cudze. Trzeba uruchomic te konkretne pliki testowe na `a0b1e4e5`
i porownac — zajmie to sekundy, w odroznieniu od pelnego przebiegu.
